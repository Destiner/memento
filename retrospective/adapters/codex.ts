import { basename } from 'node:path';

import type { ActualMemoryOperation, NormalizedEvent } from '../model.js';
import {
  canonicalMementoTool,
  createActualOperation,
  createEvent,
  isRecord,
  normalizeGitRemote,
  projectContextFromRaw,
  readJsonl,
  requireRedactedJson,
  requireRedactedText,
  safeTimestamp,
  stableId,
  stringValue,
  textFromBlocks,
  threadId,
  updateActualOperation,
  type JsonlRecord,
} from './common.js';
import type { ParsedHistoryThread, ParseHistoryOptions } from './types.js';
import { UnsupportedHistoryFormatError } from './types.js';

const CLIENT = 'codex' as const;
const CODEX_RECORD_TYPES = new Set([
  'compacted',
  'event_msg',
  'response_item',
  'session_meta',
  'turn_context',
  'world_state',
]);
const LEGACY_CODEX_RECORD_TYPES = new Set([
  'function_call',
  'function_call_output',
  'message',
  'reasoning',
]);
const MESSAGE_TEXT_TYPES = new Set(['input_text', 'output_text', 'text']);

export function parseCodexHistory(
  raw: string,
  options: ParseHistoryOptions,
): ParsedHistoryThread | null {
  const jsonl = readJsonl(raw);
  if (jsonl.nonemptyLines === 0) return null;

  const recognized = jsonl.records.filter(({ value }) => isCodexRecord(value));
  if (recognized.length === 0) {
    throw new UnsupportedHistoryFormatError('Nonempty input is not Codex history JSONL.');
  }

  const warnings: string[] = [];
  if (jsonl.malformedLines.length > 0) {
    warnings.push(`${jsonl.malformedLines.length} malformed JSONL line(s) skipped`);
  }
  const unknownCount = jsonl.records.length - recognized.length;
  if (unknownCount > 0) warnings.push(`${unknownCount} unknown Codex record(s) skipped`);

  const firstMetaRecord = recognized.find(
    ({ value }) => value.type === 'session_meta' || isLegacyMetadata(value),
  );
  const meta =
    firstMetaRecord?.value.type === 'session_meta' && isRecord(firstMetaRecord.value.payload)
      ? firstMetaRecord.value.payload
      : (firstMetaRecord?.value ?? {});
  const metadataTimestamp = safeTimestamp(firstMetaRecord?.value.timestamp ?? meta.timestamp);
  const sourceSessionId =
    stringValue(meta.id) ??
    stringValue(meta.session_id) ??
    stableId('codex-thread', options.sourceId);
  const rootSourceSessionId = stringValue(meta.session_id) ?? sourceSessionId;
  const parentSourceSessionId = stringValue(meta.parent_thread_id);
  const agentPath = stringValue(meta.agent_path);
  const normalizedThreadId = threadId(CLIENT, sourceSessionId);
  const clientVersion = stringValue(meta.cli_version);
  const cwd = meta.cwd;
  const rawCwd = stringValue(cwd);
  const git = isRecord(meta.git) ? meta.git : undefined;
  const gitRemote =
    typeof git?.repository_url === 'string' ? normalizeGitRemote(git.repository_url) : undefined;
  const repositorySlug = gitRemote ? slugFromRemote(gitRemote) : undefined;
  const model = deriveSessionModel(meta, recognized);

  const relevantRecords = removeForkReplay(recognized, {
    parentSourceSessionId,
    agentPath,
    startedAt: metadataTimestamp,
  });
  if (relevantRecords.length < recognized.length && parentSourceSessionId) {
    warnings.push('Codex fork replay records skipped');
  }

  const hasDirectUserMessages = relevantRecords.some(
    ({ value }) => eventPayloadType(value) === 'user_message',
  );
  const hasDirectAssistantMessages = relevantRecords.some(
    ({ value }) => eventPayloadType(value) === 'agent_message',
  );

  const events: NormalizedEvent[] = [];
  const actualOperations: ActualMemoryOperation[] = [];
  const operationsByRawCallId = new Map<string, ActualMemoryOperation>();
  const callsByRawCallId = new Map<string, NormalizedEvent>();
  const resultsByRawCallId = new Map<string, NormalizedEvent>();
  const resultQualityByRawCallId = new Map<string, number>();
  const resultOutcomeByRawCallId = new Map<string, 'success' | 'error'>();
  let ordinal = 0;

  const appendMessage = (
    kind: 'user_message' | 'assistant_message',
    textValue: string,
    timestamp: string | undefined,
    context: string,
    sourceMessageId: string,
  ): void => {
    const text = requireRedactedText(textValue, context);
    if (text === '') return;
    events.push(
      createEvent({
        client: CLIENT,
        sourceId: options.sourceId,
        rootSourceSessionId,
        sourceSessionId,
        sourceMessageId,
        ordinal: ordinal++,
        timestamp,
        kind,
        role: kind === 'user_message' ? 'user' : 'assistant',
        text,
      }),
    );
  };

  const replaceActualOperation = (input: {
    rawCallId: string;
    callEvent: NormalizedEvent;
    callId: string;
    toolName: string;
    toolInput: ReturnType<typeof requireRedactedJson>;
    canonical: ReturnType<typeof canonicalMementoTool>;
  }): void => {
    const previous = operationsByRawCallId.get(input.rawCallId);
    if (previous) {
      const index = actualOperations.indexOf(previous);
      if (index >= 0) actualOperations.splice(index, 1);
      operationsByRawCallId.delete(input.rawCallId);
    }
    delete input.callEvent.actualOperationId;
    const resultEvent = resultsByRawCallId.get(input.rawCallId);
    if (resultEvent) delete resultEvent.actualOperationId;
    if (!input.canonical) return;

    const operation = createActualOperation({
      client: CLIENT,
      sourceId: options.sourceId,
      rootSourceSessionId,
      sourceSessionId,
      callEventId: input.callEvent.id,
      sequence: input.callEvent.sequence,
      timestamp: input.callEvent.timestamp,
      sourceToolName: input.toolName,
      callId: input.callId,
      tool: input.canonical,
      toolInput: input.toolInput,
    });
    input.callEvent.actualOperationId = operation.id;
    actualOperations.push(operation);
    operationsByRawCallId.set(input.rawCallId, operation);
    if (resultEvent) {
      resultEvent.actualOperationId = operation.id;
      updateActualOperation(operation, {
        eventId: resultEvent.id,
        timestamp: resultEvent.timestamp,
        output: resultEvent.toolOutput,
        outcome: resultOutcomeByRawCallId.get(input.rawCallId) ?? 'success',
      });
    }
  };

  const appendCall = (input: {
    rawCallId: string;
    toolName: string;
    toolInput: unknown;
    timestamp?: string;
    serverName?: string;
    line: number;
    sourceMessageId: string;
  }): NormalizedEvent => {
    const existing = callsByRawCallId.get(input.rawCallId);
    if (existing && input.serverName === undefined) return existing;

    const callId =
      existing?.toolCall?.callId ?? stableId('call', CLIENT, options.sourceId, input.rawCallId);
    const toolName = requireRedactedText(input.toolName, `Codex line ${input.line} tool name`);
    const toolInput = requireRedactedJson(
      parseMaybeJson(input.toolInput),
      `Codex line ${input.line} tool input`,
    );
    const canonical = canonicalMementoTool(toolName, input.serverName);
    if (existing) {
      existing.sourceMessageId = input.sourceMessageId;
      existing.toolCall = {
        callId,
        name: toolName,
        input: toolInput,
        isMemento: canonical !== undefined,
      };
      replaceActualOperation({
        rawCallId: input.rawCallId,
        callEvent: existing,
        callId,
        toolName,
        toolInput,
        canonical,
      });
      return existing;
    }

    const callEvent = createEvent({
      client: CLIENT,
      sourceId: options.sourceId,
      rootSourceSessionId,
      sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      ordinal: ordinal++,
      timestamp: input.timestamp,
      kind: 'tool_call',
      role: 'assistant',
      toolCall: { callId, name: toolName, input: toolInput, isMemento: canonical !== undefined },
    });
    events.push(callEvent);
    callsByRawCallId.set(input.rawCallId, callEvent);
    replaceActualOperation({
      rawCallId: input.rawCallId,
      callEvent,
      callId,
      toolName,
      toolInput,
      canonical,
    });
    return callEvent;
  };

  const appendResult = (input: {
    rawCallId: string;
    output: unknown;
    timestamp?: string;
    line: number;
    outcome?: 'success' | 'error';
    sourceMessageId: string;
    authoritative?: boolean;
  }): void => {
    const quality = input.authoritative ? 2 : 1;
    const existing = resultsByRawCallId.get(input.rawCallId);
    if (existing && (resultQualityByRawCallId.get(input.rawCallId) ?? 0) >= quality) return;

    const callEvent = callsByRawCallId.get(input.rawCallId);
    const operation = operationsByRawCallId.get(input.rawCallId);
    const callId =
      callEvent?.toolCall?.callId ?? stableId('call', CLIENT, options.sourceId, input.rawCallId);
    const output = requireRedactedJson(
      parseMaybeJson(input.output),
      `Codex line ${input.line} tool result`,
    );
    const outcome = input.outcome ?? 'success';
    resultQualityByRawCallId.set(input.rawCallId, quality);
    resultOutcomeByRawCallId.set(input.rawCallId, outcome);
    if (existing) {
      if (input.timestamp) existing.timestamp = input.timestamp;
      existing.sourceMessageId = input.sourceMessageId;
      existing.toolOutput = output;
      if (operation) existing.actualOperationId = operation.id;
      else delete existing.actualOperationId;
      if (operation) {
        updateActualOperation(operation, {
          eventId: existing.id,
          timestamp: input.timestamp,
          output,
          outcome,
        });
      }
      return;
    }

    const resultEvent = createEvent({
      client: CLIENT,
      sourceId: options.sourceId,
      rootSourceSessionId,
      sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      ordinal: ordinal++,
      timestamp: input.timestamp,
      kind: 'tool_result',
      role: 'tool',
      toolCallId: callId,
      toolOutput: output,
      ...(operation ? { actualOperationId: operation.id } : {}),
    });
    events.push(resultEvent);
    resultsByRawCallId.set(input.rawCallId, resultEvent);
    if (operation) {
      updateActualOperation(operation, {
        eventId: resultEvent.id,
        timestamp: input.timestamp,
        output,
        outcome,
      });
    }
  };

  for (const { line, value } of relevantRecords) {
    const timestamp = safeTimestamp(value.timestamp);
    const sourceMessageId = stableId('msg', CLIENT, options.sourceId, line);
    if (value.type === 'message') {
      const role = value.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = visibleMessageText(value.content);
      if (text) {
        appendMessage(
          role === 'user' ? 'user_message' : 'assistant_message',
          text,
          timestamp,
          `Codex legacy line ${line} message`,
          sourceMessageId,
        );
      }
      continue;
    }
    if (value.type === 'function_call') {
      const toolName = stringValue(value.name);
      if (!toolName) continue;
      const rawCallId =
        stringValue(value.call_id) ?? stringValue(value.id) ?? stableId('codex-call', line);
      appendCall({
        rawCallId,
        toolName,
        toolInput: value.arguments ?? value.input ?? null,
        timestamp,
        line,
        sourceMessageId,
      });
      continue;
    }
    if (value.type === 'function_call_output') {
      const rawCallId = stringValue(value.call_id);
      if (!rawCallId) continue;
      appendResult({ rawCallId, output: value.output ?? null, timestamp, line, sourceMessageId });
      continue;
    }
    if (value.type === 'reasoning' || value.record_type === 'state' || isLegacyMetadata(value)) {
      continue;
    }

    const payload = isRecord(value.payload) ? value.payload : undefined;
    if (!payload) continue;

    if (value.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        appendMessage(
          'user_message',
          payload.message,
          timestamp,
          `Codex line ${line} user text`,
          sourceMessageId,
        );
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        appendMessage(
          'assistant_message',
          payload.message,
          timestamp,
          `Codex line ${line} assistant text`,
          sourceMessageId,
        );
      } else if (payload.type === 'mcp_tool_call_end' && isRecord(payload.invocation)) {
        const invocation = payload.invocation;
        const toolName = stringValue(invocation.tool);
        if (!toolName) continue;
        const rawCallId =
          stringValue(payload.call_id) ?? stableId('codex-mcp-call', options.sourceId, line);
        appendCall({
          rawCallId,
          toolName,
          toolInput: invocation.arguments ?? null,
          timestamp,
          serverName: stringValue(invocation.server),
          line,
          sourceMessageId,
        });
        appendResult({
          rawCallId,
          output: payload.result ?? null,
          timestamp,
          line,
          outcome: mcpOutcome(payload.result),
          sourceMessageId,
          authoritative: true,
        });
      }
      continue;
    }

    if (value.type !== 'response_item') continue;
    if (payload.type === 'agent_message') {
      const text = textFromBlocks(payload.content, MESSAGE_TEXT_TYPES);
      if (!text) continue;
      const recipient = stringValue(payload.recipient);
      const author = stringValue(payload.author);
      const kind =
        recipient === agentPath && author !== agentPath ? 'user_message' : 'assistant_message';
      appendMessage(kind, text, timestamp, `Codex line ${line} agent message`, sourceMessageId);
      continue;
    }
    if (payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (role === 'user' && hasDirectUserMessages) continue;
      if (role === 'assistant' && hasDirectAssistantMessages) continue;
      const text = textFromBlocks(payload.content, MESSAGE_TEXT_TYPES);
      if (text) {
        appendMessage(
          role === 'user' ? 'user_message' : 'assistant_message',
          text,
          timestamp,
          `Codex line ${line} message`,
          sourceMessageId,
        );
      }
      continue;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const toolName = stringValue(payload.name);
      if (!toolName) continue;
      const rawCallId =
        stringValue(payload.call_id) ?? stringValue(payload.id) ?? stableId('codex-call', line);
      appendCall({
        rawCallId,
        toolName,
        toolInput: payload.arguments ?? payload.input ?? null,
        timestamp,
        line,
        sourceMessageId,
      });
      continue;
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const rawCallId = stringValue(payload.call_id);
      if (!rawCallId) continue;
      appendResult({
        rawCallId,
        output: payload.output ?? null,
        timestamp,
        line,
        sourceMessageId,
      });
    }
  }

  actualOperations.sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const timestamps = events.flatMap((event) => (event.timestamp ? [event.timestamp] : [])).sort();
  if (events.length === 0) {
    throw new UnsupportedHistoryFormatError(
      'Codex history contained no recognizable conversation events.',
    );
  }
  const startedAt = timestamps[0] ?? metadataTimestamp;
  const endedAt = timestamps.at(-1) ?? metadataTimestamp;
  const projectContext = projectContextFromRaw({ cwd, gitRemote, repositorySlug });
  return {
    client: CLIENT,
    sourceId: options.sourceId,
    rootSourceSessionId,
    sourceSessionId,
    thread: {
      id: normalizedThreadId,
      sourceSessionId,
      ...(parentSourceSessionId ? { parentThreadId: threadId(CLIENT, parentSourceSessionId) } : {}),
      ...(agentPath
        ? { agentLabel: requireRedactedText(basename(agentPath), 'Codex agent label') }
        : {}),
    },
    events,
    actualOperations,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(model ? { model } : {}),
    ...(clientVersion ? { clientVersion } : {}),
    ...(projectContext ? { projectContext } : {}),
    ...(rawCwd || typeof gitRemote === 'string' || repositorySlug
      ? {
          projectResolutionHints: {
            ...(rawCwd ? { workingDirectory: rawCwd, nameHint: basename(rawCwd) } : {}),
            ...(typeof gitRemote === 'string' ? { gitRemote } : {}),
            ...(repositorySlug ? { repositorySlug } : {}),
          },
        }
      : {}),
    warnings,
  };
}

function removeForkReplay(
  records: JsonlRecord[],
  context: { parentSourceSessionId?: string; agentPath?: string; startedAt?: string },
): JsonlRecord[] {
  if (!context.parentSourceSessionId) return records;

  const handoffIndex = records.findIndex(({ value }) => {
    if (value.type !== 'response_item' || !isRecord(value.payload)) return false;
    return value.payload.type === 'agent_message' && value.payload.recipient === context.agentPath;
  });
  if (handoffIndex >= 0) return records.slice(handoffIndex);
  if (!context.startedAt) return records;

  const cutoff = Date.parse(context.startedAt) + 100;
  return records.filter(({ value }) => {
    const timestamp = safeTimestamp(value.timestamp);
    return !timestamp || Date.parse(timestamp) > cutoff || value.type === 'session_meta';
  });
}

function deriveSessionModel(
  metadata: Record<string, unknown>,
  records: JsonlRecord[],
): string | undefined {
  const models = new Set<string>();
  const metadataModel = stringValue(metadata.model);
  if (metadataModel) models.add(requireRedactedText(metadataModel, 'Codex model identity'));
  for (const { value } of records) {
    if (!isRecord(value.payload)) continue;
    if (value.type !== 'turn_context' && value.type !== 'session_meta') continue;
    const model = stringValue(value.payload.model);
    if (model) models.add(requireRedactedText(model, 'Codex model identity'));
  }
  return models.size > 1 ? 'mixed' : [...models][0];
}

function eventPayloadType(value: Record<string, unknown>): unknown {
  return value.type === 'event_msg' && isRecord(value.payload) ? value.payload.type : undefined;
}

function isCodexRecord(value: Record<string, unknown>): boolean {
  if (typeof value.type === 'string') {
    return CODEX_RECORD_TYPES.has(value.type) || LEGACY_CODEX_RECORD_TYPES.has(value.type);
  }
  return value.record_type === 'state' || isLegacyMetadata(value);
}

function isLegacyMetadata(value: Record<string, unknown>): boolean {
  return (
    value.type === undefined &&
    typeof value.id === 'string' &&
    typeof value.timestamp === 'string' &&
    ('instructions' in value || 'git' in value)
  );
}

function visibleMessageText(content: unknown): string | undefined {
  return typeof content === 'string' ? content : textFromBlocks(content, MESSAGE_TEXT_TYPES);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function mcpOutcome(value: unknown): 'success' | 'error' {
  if (!isRecord(value)) return 'success';
  if ('Err' in value || value.isError === true || value.is_error === true) return 'error';
  return 'success';
}

function slugFromRemote(remote: string): string | undefined {
  const withoutSuffix = remote.replace(/\.git$/i, '');
  const sshMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(withoutSuffix);
  if (sshMatch?.[1]) return sshMatch[1];
  try {
    const url = new URL(withoutSuffix);
    const slug = url.pathname.replace(/^\/+/, '');
    return slug || undefined;
  } catch {
    return undefined;
  }
}
