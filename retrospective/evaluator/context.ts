import type { ActualOperation, JsonValue, NormalizedEvent } from '../model.js';
import type { NormalizedTask } from '../tasks.js';

export type EvaluationContextMode = 'checkpoint' | 'search' | 'capture';
export const MAX_EVALUATION_EVENTS = 600;
export const MAX_EVALUATION_CONTEXT_CHARS = 250_000;

const INITIAL_EVENT_CONTENT_BUDGET = 8_192;
const MIN_EVENT_CONTENT_BUDGET = 96;
const MAX_CONTEXT_JSON_DEPTH = 12;
const MAX_CONTEXT_JSON_ITEMS = 64;
const MEMORY_OVERLAP_CHARS = 96;

interface EvaluationEvent {
  id: string;
  sequence: number;
  threadId: string;
  kind: NormalizedEvent['kind'];
  role: NormalizedEvent['role'];
  text?: string;
  contentMasked?: 'possible_memory_influence';
  tool?: {
    name: string;
    input?: JsonValue;
    output?: JsonValue;
  };
}

interface MemoryInfluenceEvidence {
  afterSequence: number;
  fragments: string[];
}

export function evaluationEvents(
  task: NormalizedTask,
  mode: EvaluationContextMode,
  throughSequence = Number.POSITIVE_INFINITY,
): EvaluationEvent[] {
  const operationsById = new Map(
    task.actualOperations.map((operation) => [operation.id, operation]),
  );
  const operationsByCallId = new Map(
    task.actualOperations.map((operation) => [operation.callId, operation]),
  );
  const operationsByEventId = new Map(
    task.actualOperations.flatMap((operation) => [
      [operation.callEventId, operation] as const,
      ...(operation.resultEventId === undefined
        ? []
        : ([[operation.resultEventId, operation]] as const)),
    ]),
  );
  const mementoCallMessageIds = new Set(
    task.events.flatMap((event) => {
      if (event.kind !== 'tool_call' || event.sourceMessageId === undefined) return [];
      return operationFor(event, operationsById, operationsByCallId, operationsByEventId) !==
        undefined || event.toolCall?.isMemento === true
        ? [event.sourceMessageId]
        : [];
    }),
  );
  const influenceEvidence = memoryInfluenceEvidence(task, throughSequence);

  const visible = task.events
    .filter((event) => event.sequence <= throughSequence)
    .filter(
      (event) =>
        !shouldMask(
          event,
          mode,
          operationsById,
          operationsByCallId,
          operationsByEventId,
          mementoCallMessageIds,
        ),
    );

  if (visible.length === 0) return [];

  let eventLimit = Math.min(visible.length, MAX_EVALUATION_EVENTS);
  let contentBudget = INITIAL_EVENT_CONTENT_BUDGET;

  for (;;) {
    const selected = selectRepresentativeEvents(visible, eventLimit);
    const result = selected.map((event, sequence) =>
      toEvaluationEvent(
        event,
        sequence,
        contentBudget,
        hasPossibleMemoryInfluence(event, influenceEvidence),
      ),
    );
    const serializedLength = JSON.stringify(result).length;
    if (serializedLength <= MAX_EVALUATION_CONTEXT_CHARS) return result;

    if (contentBudget > MIN_EVENT_CONTENT_BUDGET) {
      contentBudget = Math.max(MIN_EVENT_CONTENT_BUDGET, Math.floor(contentBudget / 2));
      continue;
    }

    if (eventLimit > 1) {
      const proportionalLimit = Math.floor(
        eventLimit * (MAX_EVALUATION_CONTEXT_CHARS / serializedLength) * 0.9,
      );
      eventLimit = Math.max(1, Math.min(eventLimit - 1, proportionalLimit));
      continue;
    }

    const minimal = toMinimalEvaluationEvent(selected[0]!);
    if (JSON.stringify([minimal]).length <= MAX_EVALUATION_CONTEXT_CHARS) return [minimal];
    return [];
  }
}

function shouldMask(
  event: NormalizedEvent,
  mode: EvaluationContextMode,
  operationsById: ReadonlyMap<string, ActualOperation>,
  operationsByCallId: ReadonlyMap<string, ActualOperation>,
  operationsByEventId: ReadonlyMap<string, ActualOperation>,
  mementoCallMessageIds: ReadonlySet<string>,
): boolean {
  const operation = operationFor(event, operationsById, operationsByCallId, operationsByEventId);
  const isMemento = operation !== undefined || event.toolCall?.isMemento === true;
  const isCallNarration =
    event.kind === 'assistant_message' &&
    event.sourceMessageId !== undefined &&
    mementoCallMessageIds.has(event.sourceMessageId);
  if (!isMemento && !isCallNarration) return false;

  return mode === 'checkpoint' || mode === 'search' || mode === 'capture';
}

function operationFor(
  event: NormalizedEvent,
  operationsById: ReadonlyMap<string, ActualOperation>,
  operationsByCallId: ReadonlyMap<string, ActualOperation>,
  operationsByEventId: ReadonlyMap<string, ActualOperation>,
): ActualOperation | undefined {
  return (
    (event.actualOperationId === undefined
      ? undefined
      : operationsById.get(event.actualOperationId)) ??
    operationsByEventId.get(event.id) ??
    (event.toolCallId === undefined ? undefined : operationsByCallId.get(event.toolCallId)) ??
    (event.toolCall === undefined ? undefined : operationsByCallId.get(event.toolCall.callId))
  );
}

function selectRepresentativeEvents(events: NormalizedEvent[], limit: number): NormalizedEvent[] {
  if (events.length <= limit) return events;
  if (limit === 1) return [events[0]!];

  const selected = new Set<number>([0, events.length - 1]);
  const semanticIndices = events.flatMap((event, index) =>
    event.kind === 'user_message' || event.kind === 'tool_call' || event.kind === 'tool_result'
      ? [index]
      : [],
  );
  const semanticLimit = Math.min(semanticIndices.length, Math.max(0, Math.floor(limit / 2) - 1));
  addEvenSample(selected, semanticIndices, semanticLimit, limit);
  addStratifiedFill(selected, events.length, limit);

  if (selected.size < limit) {
    for (let index = 0; index < events.length && selected.size < limit; index += 1) {
      selected.add(index);
    }
  }

  return [...selected].sort((left, right) => left - right).map((index) => events[index]!);
}

function addStratifiedFill(destination: Set<number>, length: number, limit: number): void {
  while (destination.size < limit) {
    const remaining = limit - destination.size;
    const sizeBefore = destination.size;
    for (let slot = 0; slot < remaining && destination.size < limit; slot += 1) {
      const start = Math.floor((slot * length) / remaining);
      const end = Math.max(start, Math.floor(((slot + 1) * length) / remaining) - 1);
      const center = Math.floor((start + end) / 2);
      for (let offset = 0; offset <= end - start; offset += 1) {
        const right = center + offset;
        const left = center - offset;
        if (right <= end && !destination.has(right)) {
          destination.add(right);
          break;
        }
        if (left >= start && !destination.has(left)) {
          destination.add(left);
          break;
        }
      }
    }
    if (destination.size === sizeBefore) break;
  }
}

function addEvenSample(
  destination: Set<number>,
  candidates: number[],
  count: number,
  limit: number,
): void {
  if (count <= 0 || candidates.length === 0) return;
  if (count === 1) {
    if (destination.size < limit) destination.add(candidates[Math.floor(candidates.length / 2)]!);
    return;
  }
  for (let slot = 0; slot < count && destination.size < limit; slot += 1) {
    const position = Math.round((slot * (candidates.length - 1)) / (count - 1));
    destination.add(candidates[position]!);
  }
}

function toEvaluationEvent(
  event: NormalizedEvent,
  contextSequence: number,
  contentBudget: number,
  possibleMemoryInfluence: boolean,
): EvaluationEvent {
  const tool = event.toolCall;
  return {
    id: event.id,
    sequence: contextSequence,
    threadId: event.threadId,
    kind: event.kind,
    role: event.role,
    ...(possibleMemoryInfluence
      ? { contentMasked: 'possible_memory_influence' as const }
      : event.text === undefined
        ? {}
        : { text: truncateContextString(event.text, contentBudget, 'TEXT') }),
    ...(tool === undefined && event.toolOutput === undefined
      ? {}
      : {
          tool: {
            name: truncateContextString(tool?.name ?? 'tool_result', 256, 'TOOL_NAME'),
            ...(tool?.input === undefined
              ? {}
              : { input: boundContextJson(tool.input, Math.max(48, contentBudget / 2)) }),
            ...(event.toolOutput === undefined
              ? {}
              : { output: boundContextJson(event.toolOutput, Math.max(48, contentBudget / 2)) }),
          },
        }),
  };
}

function toMinimalEvaluationEvent(event: NormalizedEvent): EvaluationEvent {
  return {
    id: event.id,
    sequence: 0,
    threadId: event.threadId,
    kind: event.kind,
    role: event.role,
  };
}

function boundContextJson(input: JsonValue, limit: number): JsonValue {
  const budget = { remaining: Math.max(16, Math.floor(limit) - 64) };
  const result = boundContextJsonValue(input, 0, budget);
  if (JSON.stringify(result).length <= limit) return result;
  return truncateContextString(JSON.stringify(input), Math.max(16, Math.floor(limit)), 'JSON');
}

function boundContextJsonValue(
  input: JsonValue,
  depth: number,
  budget: { remaining: number },
): JsonValue {
  if (depth >= MAX_CONTEXT_JSON_DEPTH) return '[TRUNCATED:CONTEXT_JSON_DEPTH]';
  if (budget.remaining <= 0) return '[TRUNCATED:CONTEXT_JSON_BUDGET]';
  if (input === null || typeof input === 'boolean' || typeof input === 'number') {
    budget.remaining -= String(input).length;
    return input;
  }
  if (typeof input === 'string') {
    const value = truncateContextString(
      input,
      Math.max(16, Math.min(8_192, budget.remaining)),
      'JSON_STRING',
    );
    budget.remaining -= value.length;
    return value;
  }
  if (Array.isArray(input)) {
    const indices = representativeJsonIndices(input.length);
    const output: JsonValue[] = [];
    for (const index of indices) {
      if (index === -1) {
        output.push(`[TRUNCATED:ARRAY ${input.length - MAX_CONTEXT_JSON_ITEMS} item(s)]`);
      } else {
        output.push(boundContextJsonValue(input[index]!, depth + 1, budget));
      }
      if (budget.remaining <= 0) break;
    }
    return output;
  }

  const output: { [key: string]: JsonValue } = {};
  const entries = Object.entries(input);
  const limit = Math.min(entries.length, MAX_CONTEXT_JSON_ITEMS);
  let consumed = 0;
  for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
    const entry = entries[index]!;
    const key = truncateContextString(entry[0], 128, 'JSON_KEY');
    budget.remaining -= key.length;
    output[uniqueContextKey(output, key)] = boundContextJsonValue(entry[1], depth + 1, budget);
    consumed += 1;
  }
  if (consumed < entries.length) {
    output[uniqueContextKey(output, '_retrospective_truncation')] =
      `[TRUNCATED:OBJECT ${entries.length - consumed} key(s)]`;
  }
  return output;
}

function representativeJsonIndices(length: number): number[] {
  if (length <= MAX_CONTEXT_JSON_ITEMS) {
    return Array.from({ length }, (_, index) => index);
  }
  const half = Math.floor(MAX_CONTEXT_JSON_ITEMS / 2);
  return [
    ...Array.from({ length: half }, (_, index) => index),
    -1,
    ...Array.from({ length: MAX_CONTEXT_JSON_ITEMS - half }, (_, index) => length - half + index),
  ];
}

function truncateContextString(input: string, rawLimit: number, category: string): string {
  const limit = Math.max(16, Math.floor(rawLimit));
  if (input.length <= limit) return input;
  const marker = `[TRUNCATED:${category} ${input.length - limit} chars]`;
  if (marker.length >= limit) return marker.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.65);
  return `${input.slice(0, head)}${marker}${input.slice(input.length - (available - head))}`;
}

function uniqueContextKey(output: { [key: string]: JsonValue }, preferred: string): string {
  if (!(preferred in output)) return preferred;
  let suffix = 2;
  while (`${preferred}#${suffix}` in output) suffix += 1;
  return `${preferred}#${suffix}`;
}

function memoryInfluenceEvidence(
  task: NormalizedTask,
  throughSequence: number,
): MemoryInfluenceEvidence[] {
  const sequenceByEventId = new Map(task.events.map((event) => [event.id, event.sequence]));
  return task.actualOperations.flatMap((operation) => {
    if (
      (operation.kind !== 'search' && operation.kind !== 'read') ||
      operation.output === undefined
    ) {
      return [];
    }
    const afterSequence =
      operation.resultEventId === undefined
        ? operation.sequence
        : (sequenceByEventId.get(operation.resultEventId) ?? operation.sequence);
    if (afterSequence > throughSequence) return [];
    const fragments = collectDistinctiveFragments(operation.output);
    return fragments.length === 0 ? [] : [{ afterSequence, fragments }];
  });
}

function collectDistinctiveFragments(value: JsonValue): string[] {
  const output: string[] = [];
  visitJsonStrings(value, (text) => {
    const normalized = normalizeForOverlap(text);
    if (normalized.length >= MEMORY_OVERLAP_CHARS && isDistinctive(normalized)) {
      output.push(normalized);
    }
  });
  return output.slice(0, 128);
}

function hasPossibleMemoryInfluence(
  event: NormalizedEvent,
  evidence: MemoryInfluenceEvidence[],
): boolean {
  if (event.kind !== 'assistant_message' || event.text === undefined) return false;
  const text = normalizeForOverlap(event.text);
  if (text.length < MEMORY_OVERLAP_CHARS) return false;
  return evidence.some(
    (candidate) =>
      event.sequence > candidate.afterSequence &&
      candidate.fragments.some((fragment) => hasDistinctiveOverlap(text, fragment)),
  );
}

function hasDistinctiveOverlap(text: string, evidence: string): boolean {
  const shorter = text.length <= evidence.length ? text : evidence;
  const longer = text.length <= evidence.length ? evidence : text;
  if (shorter.length >= MEMORY_OVERLAP_CHARS && longer.includes(shorter)) return true;

  for (
    let offset = 0;
    offset + MEMORY_OVERLAP_CHARS <= evidence.length;
    offset += MEMORY_OVERLAP_CHARS
  ) {
    if (text.includes(evidence.slice(offset, offset + MEMORY_OVERLAP_CHARS))) return true;
  }
  return false;
}

function normalizeForOverlap(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isDistinctive(input: string): boolean {
  const words = new Set(input.match(/[a-z0-9_./:-]{3,}/g) ?? []);
  return words.size >= 8 || new Set(input).size >= 24;
}

function visitJsonStrings(value: JsonValue, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const item of Object.values(value)) visitJsonStrings(item, visit);
}
