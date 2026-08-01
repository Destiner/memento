import { basename } from 'node:path';

import type { ActualMemoryOperation, NormalizedEvent } from '../model.js';
import {
  canonicalMementoTool,
  createActualOperation,
  createEvent,
  isRecord,
  projectContextFromRaw,
  readJsonl,
  requireRedactedJson,
  requireRedactedText,
  safeTimestamp,
  stableId,
  stringValue,
  threadId,
  updateActualOperation,
} from './common.js';
import type { ParsedHistoryThread, ParseHistoryOptions } from './types.js';
import { UnsupportedHistoryFormatError } from './types.js';

const CLIENT = 'claude-code' as const;
const CLAUDE_RECORD_TYPES = new Set([
  'ai-title',
  'assistant',
  'attachment',
  'file-history-snapshot',
  'last-prompt',
  'progress',
  'queue-operation',
  'summary',
  'system',
  'user',
]);

export function parseClaudeCodeHistory(
  raw: string,
  options: ParseHistoryOptions,
): ParsedHistoryThread | null {
  const jsonl = readJsonl(raw);
  if (jsonl.nonemptyLines === 0) return null;

  const recognized = jsonl.records.filter(
    ({ value }) => typeof value.type === 'string' && CLAUDE_RECORD_TYPES.has(value.type),
  );
  if (recognized.length === 0) {
    throw new UnsupportedHistoryFormatError('Nonempty input is not Claude Code history JSONL.');
  }

  const warnings: string[] = [];
  if (jsonl.malformedLines.length > 0) {
    warnings.push(`${jsonl.malformedLines.length} malformed JSONL line(s) skipped`);
  }
  const unknownCount = jsonl.records.length - recognized.length;
  if (unknownCount > 0) warnings.push(`${unknownCount} unknown Claude Code record(s) skipped`);

  const metadata = recognized.map(({ value }) => value);
  const rootSourceSessionId =
    firstString(metadata, 'sessionId') ?? stableId('claude-session', options.sourceId);
  const agentId =
    firstString(metadata, 'agentId') ?? agentIdFromPath(options.sourcePathHint) ?? undefined;
  const sourceSessionId = agentId ?? rootSourceSessionId;
  const normalizedThreadId = threadId(CLIENT, sourceSessionId);
  const rootThreadId = threadId(CLIENT, rootSourceSessionId);
  const cwd = firstValue(metadata, 'cwd');
  const rawCwd = stringValue(cwd);
  const clientVersion = firstString(metadata, 'version');

  const events: NormalizedEvent[] = [];
  const actualOperations: ActualMemoryOperation[] = [];
  const operationsByRawCallId = new Map<string, ActualMemoryOperation>();
  const observedModels = new Set<string>();
  let ordinal = 0;

  for (const { line, value } of recognized) {
    const timestamp = safeTimestamp(value.timestamp);
    const sourceMessageId = stableId('msg', CLIENT, options.sourceId, line);
    if (value.type === 'assistant') {
      const message = isRecord(value.message) ? value.message : undefined;
      const observedModel = stringValue(message?.model);
      if (observedModel) {
        observedModels.add(
          requireRedactedText(observedModel, `Claude Code line ${line} model identity`),
        );
      }
      const content = message?.content;
      if (!Array.isArray(content)) continue;

      for (const [blockIndex, blockValue] of content.entries()) {
        if (!isRecord(blockValue)) continue;
        if (blockValue.type === 'text' && typeof blockValue.text === 'string') {
          const text = requireRedactedText(
            blockValue.text,
            `Claude Code line ${line} assistant text`,
          );
          if (text !== '') {
            events.push(
              createEvent({
                client: CLIENT,
                sourceId: options.sourceId,
                rootSourceSessionId,
                sourceSessionId,
                sourceMessageId,
                ordinal: ordinal++,
                timestamp,
                kind: 'assistant_message',
                role: 'assistant',
                text,
              }),
            );
          }
          continue;
        }
        if (blockValue.type !== 'tool_use' || typeof blockValue.name !== 'string') continue;

        const rawCallId =
          stringValue(blockValue.id) ??
          stableId('claude-raw-call', options.sourceId, line, blockIndex);
        const callId = stableId('call', CLIENT, options.sourceId, rawCallId);
        const toolName = requireRedactedText(blockValue.name, `Claude Code line ${line} tool name`);
        const toolInput = requireRedactedJson(
          blockValue.input ?? null,
          `Claude Code line ${line} tool input`,
        );
        const canonical = canonicalMementoTool(toolName);
        const callEvent = createEvent({
          client: CLIENT,
          sourceId: options.sourceId,
          rootSourceSessionId,
          sourceSessionId,
          sourceMessageId,
          ordinal: ordinal++,
          timestamp,
          kind: 'tool_call',
          role: 'assistant',
          toolCall: {
            callId,
            name: toolName,
            input: toolInput,
            isMemento: canonical !== undefined,
          },
        });
        events.push(callEvent);

        if (canonical) {
          const operation = createActualOperation({
            client: CLIENT,
            sourceId: options.sourceId,
            rootSourceSessionId,
            sourceSessionId,
            callEventId: callEvent.id,
            sequence: callEvent.sequence,
            timestamp,
            sourceToolName: toolName,
            callId,
            tool: canonical,
            toolInput,
          });
          callEvent.actualOperationId = operation.id;
          actualOperations.push(operation);
          operationsByRawCallId.set(rawCallId, operation);
        }
      }
      continue;
    }

    if (value.type !== 'user' || isFilteredUserRecord(value)) continue;
    const message = isRecord(value.message) ? value.message : undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      const text = requireRedactedText(content, `Claude Code line ${line} user text`);
      if (text !== '') {
        events.push(
          createEvent({
            client: CLIENT,
            sourceId: options.sourceId,
            rootSourceSessionId,
            sourceSessionId,
            sourceMessageId,
            ordinal: ordinal++,
            timestamp,
            kind: 'user_message',
            role: 'user',
            text,
          }),
        );
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const blockValue of content) {
      if (!isRecord(blockValue)) continue;
      if (blockValue.type === 'text' && typeof blockValue.text === 'string') {
        const text = requireRedactedText(blockValue.text, `Claude Code line ${line} user text`);
        if (text !== '') {
          events.push(
            createEvent({
              client: CLIENT,
              sourceId: options.sourceId,
              rootSourceSessionId,
              sourceSessionId,
              sourceMessageId,
              ordinal: ordinal++,
              timestamp,
              kind: 'user_message',
              role: 'user',
              text,
            }),
          );
        }
        continue;
      }
      if (blockValue.type !== 'tool_result') continue;

      const rawCallId = stringValue(blockValue.tool_use_id) ?? '';
      const callId = stableId('call', CLIENT, options.sourceId, rawCallId || `line-${line}`);
      const output = requireRedactedJson(
        value.toolUseResult ?? blockValue.content ?? null,
        `Claude Code line ${line} tool result`,
      );
      const operation = operationsByRawCallId.get(rawCallId);
      const resultEvent = createEvent({
        client: CLIENT,
        sourceId: options.sourceId,
        rootSourceSessionId,
        sourceSessionId,
        sourceMessageId,
        ordinal: ordinal++,
        timestamp,
        kind: 'tool_result',
        role: 'tool',
        toolCallId: callId,
        toolOutput: output,
        ...(operation ? { actualOperationId: operation.id } : {}),
      });
      events.push(resultEvent);
      if (operation) {
        updateActualOperation(operation, {
          eventId: resultEvent.id,
          timestamp,
          output,
          outcome: blockValue.is_error === true ? 'error' : 'success',
        });
      }
    }
  }

  const timestamps = events.flatMap((event) => (event.timestamp ? [event.timestamp] : []));
  if (events.length === 0) {
    throw new UnsupportedHistoryFormatError(
      'Claude Code history contained no recognizable conversation events.',
    );
  }
  const model = observedModels.size > 1 ? 'mixed' : [...observedModels][0];
  return {
    client: CLIENT,
    sourceId: options.sourceId,
    rootSourceSessionId,
    sourceSessionId,
    thread: {
      id: normalizedThreadId,
      sourceSessionId,
      ...(agentId
        ? { parentThreadId: rootThreadId, agentLabel: `agent-${agentId.slice(-8)}` }
        : {}),
    },
    events,
    actualOperations,
    ...(timestamps[0] ? { startedAt: [...timestamps].sort()[0] } : {}),
    ...(timestamps[0] ? { endedAt: [...timestamps].sort().at(-1) } : {}),
    ...(model ? { model } : {}),
    ...(clientVersion ? { clientVersion } : {}),
    ...((cwd !== undefined ? { projectContext: projectContextFromRaw({ cwd }) } : {}) as {
      projectContext?: ReturnType<typeof projectContextFromRaw>;
    }),
    ...(rawCwd
      ? {
          projectResolutionHints: {
            workingDirectory: rawCwd,
            nameHint: basename(rawCwd),
          },
        }
      : {}),
    warnings,
  };
}

function firstString(records: Record<string, unknown>[], key: string): string | undefined {
  const value = firstValue(records, key);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function firstValue(records: Record<string, unknown>[], key: string): unknown {
  return records.find((record) => record[key] !== undefined)?.[key];
}

function agentIdFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(basename(path));
  return match?.[1];
}

function isFilteredUserRecord(record: Record<string, unknown>): boolean {
  if (record.isMeta === true) return true;
  const message = isRecord(record.message) ? record.message : undefined;
  if (stringValue(message?.role)?.toLowerCase() === 'system') return true;
  const promptSource = record.promptSource;
  if (typeof promptSource === 'string') return promptSource.toLowerCase() === 'system';
  if (!isRecord(promptSource)) return false;
  return [promptSource.type, promptSource.kind, promptSource.source].some(
    (value) => typeof value === 'string' && value.toLowerCase() === 'system',
  );
}
