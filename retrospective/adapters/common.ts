import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  NORMALIZED_SCHEMA_VERSION,
  type ActualMemoryOperation,
  type ActualOperationKind,
  type ActualOperationOutcome,
  type CanonicalMementoTool,
  type HistoryClient,
  type JsonValue,
  type NormalizedEvent,
  type NormalizedEventKind,
  type NormalizedEventRole,
  type OperationScope,
  type ProjectContext,
} from '../model.js';
import { boundJson, boundText, redactJson, redactText } from '../redact.js';
import { UnsafeHistoryError } from './types.js';

const TOOL_ALIASES: Record<string, CanonicalMementoTool> = {
  resolve_project: 'resolve_project',
  create_project: 'create_project',
  update_project: 'update_project',
  search_memories: 'search_memories',
  get_memory: 'get_memory',
  create_memory: 'create_memory',
  update_memory: 'update_memory',
  archive_memory: 'archive_memory',
  search_memory: 'search_memories',
  read_memory: 'get_memory',
  answer_memory: 'legacy_query',
};

const DROPPED_CONTENT_TYPES = new Set([
  'attachment',
  'audio',
  'computer_screenshot',
  'document',
  'encrypted_content',
  'file',
  'image',
  'image_url',
  'input_audio',
  'input_image',
  'local_audio',
  'local_image',
  'reasoning',
  'thinking',
]);

const DROPPED_KEYS = new Set([
  'attachment',
  'attachments',
  'audio',
  'document',
  'documents',
  'file',
  'files',
  'image',
  'images',
  'input_audio',
  'input_image',
  'local_audio',
  'local_images',
  'reasoning',
  'thinking',
  'world_state',
]);

export interface JsonlRecord {
  line: number;
  value: Record<string, unknown>;
}

export interface JsonlReadResult {
  records: JsonlRecord[];
  nonemptyLines: number;
  malformedLines: number[];
}

export function readJsonl(raw: string): JsonlReadResult {
  const records: JsonlRecord[] = [];
  const malformedLines: number[] = [];
  let nonemptyLines = 0;

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    nonemptyLines += 1;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push({ line: index + 1, value: parsed });
      else malformedLines.push(index + 1);
    } catch {
      malformedLines.push(index + 1);
    }
  }

  return { records, nonemptyLines, malformedLines };
}

export function stableId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const digest = createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export function sessionId(client: HistoryClient, rootSourceSessionId: string): string {
  return stableId('ses', client, rootSourceSessionId);
}

export function threadId(client: HistoryClient, sourceSessionId: string): string {
  return stableId('thr', client, sourceSessionId);
}

export function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

export function requireRedactedText(value: string, context: string): string {
  const result = redactText(value);
  if (!result.ok) throw new UnsafeHistoryError(`${context}: ${result.reason}`);
  return boundText(result.value);
}

export function requireRedactedJson(value: unknown, context: string): JsonValue {
  const stripped = stripNonPersistable(value);
  const result = redactJson(stripped ?? null);
  if (!result.ok) throw new UnsafeHistoryError(`${context}: ${result.reason}`);
  return boundJson(result.value);
}

export function stripNonPersistable(value: unknown, depth = 0): unknown {
  if (depth > 64) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => stripNonPersistable(item, depth + 1))
      .filter((item) => item !== undefined);
    return items;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.type === 'string' && DROPPED_CONTENT_TYPES.has(value.type)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    const stripped = stripNonPersistable(item, depth + 1);
    if (stripped !== undefined) result[key] = stripped;
  }
  return result;
}

export function canonicalMementoTool(
  sourceName: string,
  serverName?: string,
): CanonicalMementoTool | undefined {
  const lower = sourceName.trim().toLowerCase();
  let localName = lower;
  const normalizedServer = serverName?.trim().toLowerCase();
  if (normalizedServer && normalizedServer !== 'memento') return undefined;
  let explicitlyMemento = normalizedServer === 'memento';

  for (const prefix of ['mcp__memento__', 'memento__', 'memento/', 'memento.']) {
    if (localName.startsWith(prefix)) {
      localName = localName.slice(prefix.length);
      explicitlyMemento = true;
      break;
    }
  }

  const canonical = TOOL_ALIASES[localName];
  if (!canonical) return undefined;
  if (explicitlyMemento) return canonical;

  return TOOL_ALIASES[lower];
}

export function normalizeGitRemote(value: string): string | undefined {
  const remote = value.trim();
  if (remote === '') return undefined;
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(remote)) return remote;
  if (!remote.includes('://')) return undefined;

  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function operationKind(tool: CanonicalMementoTool): ActualOperationKind {
  if (tool === 'search_memories' || tool === 'legacy_query') return 'search';
  if (tool === 'get_memory') return 'read';
  if (tool === 'create_memory' || tool === 'update_memory') return 'write';
  if (tool === 'archive_memory') return 'archive';
  return 'project';
}

export function createEvent(input: {
  client: HistoryClient;
  sourceId: string;
  rootSourceSessionId: string;
  sourceSessionId: string;
  sourceMessageId?: string;
  ordinal: number;
  timestamp?: string;
  kind: NormalizedEventKind;
  role: NormalizedEventRole;
  text?: string;
  toolCall?: NormalizedEvent['toolCall'];
  toolCallId?: string;
  toolOutput?: JsonValue;
  actualOperationId?: string;
}): NormalizedEvent {
  const normalizedSessionId = sessionId(input.client, input.rootSourceSessionId);
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: stableId('evt', input.client, input.sourceId, input.ordinal, input.kind),
    sessionId: normalizedSessionId,
    threadId: threadId(input.client, input.sourceSessionId),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    sequence: input.ordinal,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    kind: input.kind,
    role: input.role,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.toolCall ? { toolCall: input.toolCall } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.toolOutput !== undefined ? { toolOutput: input.toolOutput } : {}),
    ...(input.actualOperationId ? { actualOperationId: input.actualOperationId } : {}),
  };
}

export function createActualOperation(input: {
  client: HistoryClient;
  sourceId: string;
  rootSourceSessionId: string;
  sourceSessionId: string;
  callEventId: string;
  resultEventId?: string;
  sequence: number;
  timestamp?: string;
  completedAt?: string;
  sourceToolName: string;
  callId: string;
  tool: CanonicalMementoTool;
  toolInput?: JsonValue;
  output?: JsonValue;
  outcome?: ActualOperationOutcome;
}): ActualMemoryOperation {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: stableId('op', input.client, input.sourceId, input.callId),
    sessionId: sessionId(input.client, input.rootSourceSessionId),
    threadId: threadId(input.client, input.sourceSessionId),
    callEventId: input.callEventId,
    ...(input.resultEventId ? { resultEventId: input.resultEventId } : {}),
    sequence: input.sequence,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    tool: input.tool,
    kind: operationKind(input.tool),
    sourceToolName: input.sourceToolName,
    callId: input.callId,
    ...(input.toolInput !== undefined ? { input: input.toolInput } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    outcome: input.outcome ?? 'unknown',
    ...scopeFromInput(input.tool, input.toolInput),
    ...memoryIdsFromOutput(input.output),
  };
}

export function updateActualOperation(
  operation: ActualMemoryOperation,
  result: {
    eventId: string;
    timestamp?: string;
    output?: JsonValue;
    outcome: ActualOperationOutcome;
  },
): void {
  operation.resultEventId = result.eventId;
  if (result.timestamp) operation.completedAt = result.timestamp;
  if (result.output !== undefined) operation.output = result.output;
  operation.outcome = result.outcome;
  const ids = extractMemoryIds(result.output);
  if (ids.length > 0) operation.memoryIds = ids;
  if (operation.tool === 'update_memory') {
    const resultScope = scopeFromResult(result.output);
    if (resultScope) operation.scope = resultScope;
  }
}

export function projectContextFromRaw(input: {
  cwd?: unknown;
  gitRemote?: unknown;
  repositorySlug?: unknown;
}): ProjectContext | undefined {
  const output: ProjectContext = {};
  if (typeof input.cwd === 'string' && input.cwd.trim() !== '') {
    output.workingDirectory = requireRedactedText(input.cwd, 'working directory');
    output.workingDirectoryName = requireRedactedText(
      basename(input.cwd),
      'working directory name',
    );
  }
  if (typeof input.gitRemote === 'string' && input.gitRemote.trim() !== '') {
    output.gitRemote = requireRedactedText(input.gitRemote, 'git remote');
  }
  if (typeof input.repositorySlug === 'string' && input.repositorySlug.trim() !== '') {
    output.repositorySlug = requireRedactedText(input.repositorySlug, 'repository slug');
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function textFromBlocks(value: unknown, allowedTypes: Set<string>): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(isRecord)
    .filter((block) => typeof block.type === 'string' && allowedTypes.has(block.type))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
  return text === '' ? undefined : text;
}

function scopeFromInput(
  tool: CanonicalMementoTool,
  input: JsonValue | undefined,
): { scope?: OperationScope } {
  if (!isRecord(input)) return {};
  if (tool === 'legacy_query' && typeof input.project === 'string') {
    return { scope: { kind: 'unknown' } };
  }
  const changes = tool === 'update_memory' && isRecord(input.changes) ? input.changes : undefined;
  const rawScope = changes?.scope ?? input.scope;
  const scope = normalizeScope(rawScope);
  return scope ? { scope } : {};
}

function normalizeScope(rawScope: unknown): OperationScope | undefined {
  if (!isRecord(rawScope)) return undefined;
  const kind = rawScope.kind;
  if (kind !== 'projects' && kind !== 'global') return { kind: 'unknown' };
  if (kind === 'global') return { kind: 'global' };
  const projectIds = Array.isArray(rawScope.project_ids)
    ? rawScope.project_ids.filter((id): id is string => typeof id === 'string')
    : undefined;
  const match = rawScope.match === 'any' || rawScope.match === 'all' ? rawScope.match : undefined;
  return {
    kind: 'projects',
    ...(projectIds && projectIds.length > 0 ? { projectIds } : {}),
    ...(match ? { match } : {}),
  };
}

function scopeFromResult(value: unknown, depth = 0): OperationScope | undefined {
  if (depth > 16) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const scope = scopeFromResult(item, depth + 1);
      if (scope) return scope;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.memory) && 'scope' in value.memory) {
    return normalizeScope(value.memory.scope);
  }
  for (const item of Object.values(value)) {
    const scope = scopeFromResult(item, depth + 1);
    if (scope) return scope;
  }
  return undefined;
}

function memoryIdsFromOutput(output: JsonValue | undefined): { memoryIds?: string[] } {
  const ids = extractMemoryIds(output);
  return ids.length > 0 ? { memoryIds: ids } : {};
}

function extractMemoryIds(value: unknown): string[] {
  const ids = new Set<string>();
  visit(value, (item) => {
    if (typeof item === 'string' && /^mem_[A-Za-z0-9]+$/.test(item)) ids.add(item);
  });
  return [...ids].sort();
}

function visit(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) visit(item, visitor);
  }
}
