import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseClaudeCodeHistory, parseCodexHistory } from './adapters/index.js';
import type { HistorySource } from './discover.js';
import { fingerprintHistoryContent, ingestHistorySources, mergeParsedThreads } from './ingest.js';
import { detectSensitiveKinds, MAX_NORMALIZED_TEXT_CHARS } from './redact.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('retrospective history ingestion', () => {
  it('normalizes Claude Code history and legacy Memento names safely', async () => {
    const raw = await readFile(fixture('claude-history.jsonl'), 'utf8');
    const first = parseClaudeCodeHistory(raw, {
      sourceId: 'claude-fixture',
      sourcePathHint: fixture('claude-history.jsonl'),
    });
    const second = parseClaudeCodeHistory(raw, {
      sourceId: 'claude-fixture',
      sourcePathHint: fixture('claude-history.jsonl'),
    });

    expect(first).toEqual(second);
    expect(first?.actualOperations).toHaveLength(1);
    expect(first?.actualOperations[0]).toMatchObject({
      tool: 'search_memories',
      sourceToolName: 'mcp__memento__search_memory',
      outcome: 'success',
      memoryIds: ['mem_01TEST'],
    });
    expect(first?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('malformed'),
        expect.stringContaining('unknown'),
      ]),
    );
    const assistantNarration = first?.events.find((event) => event.kind === 'assistant_message');
    const mementoCall = first?.events.find((event) => event.kind === 'tool_call');
    expect(assistantNarration?.sourceMessageId).toBe(mementoCall?.sourceMessageId);
    expect(assistantNarration?.sourceMessageId).toMatch(/^msg_/);
    assertPersistable(first);
  });

  it('normalizes Codex current and legacy calls while dropping private record types', async () => {
    const raw = await readFile(fixture('codex-history.jsonl'), 'utf8');
    const parsed = parseCodexHistory(raw, {
      sourceId: 'codex-fixture',
      sourcePathHint: fixture('codex-history.jsonl'),
    });

    expect(parsed?.actualOperations.map((operation) => operation.tool)).toEqual([
      'create_memory',
      'search_memories',
    ]);
    expect(parsed?.actualOperations[0]).toMatchObject({
      outcome: 'success',
      scope: { kind: 'projects', projectIds: ['prj_01TEST'] },
      memoryIds: ['mem_01CREATED'],
    });
    expect(parsed?.projectContext).toMatchObject({
      workingDirectory: '[REDACTED:PATH]',
      workingDirectoryName: 'project',
      gitRemote: 'https://example.com/acme/project.git',
      repositorySlug: 'acme/project',
    });
    expect(parsed?.events.every((event) => event.sourceMessageId?.startsWith('msg_'))).toBe(true);
    assertPersistable(parsed);
  });

  it('supports legacy Codex rollout records without retaining private metadata', async () => {
    const raw = await readFile(fixture('codex-legacy-history.jsonl'), 'utf8');
    const parsed = parseCodexHistory(raw, {
      sourceId: 'codex-legacy-fixture',
      sourcePathHint: fixture('codex-legacy-history.jsonl'),
    });

    expect(parsed?.sourceSessionId).toBe('legacy-codex-session');
    expect(parsed?.events.map((event) => event.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
    ]);
    expect(parsed?.events.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(parsed?.actualOperations).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        tool: 'search_memories',
        sourceToolName: 'search_memory',
        outcome: 'success',
        memoryIds: ['mem_01LEGACY'],
      }),
    ]);
    expect(parsed?.startedAt).toBe('2026-06-01T09:00:00.000Z');
    expect(parsed?.projectContext?.repositorySlug).toBe('acme/legacy');
    assertPersistable(parsed);
  });

  it('merges root and child Codex histories into a chronological task graph', async () => {
    const [rootRaw, childRaw] = await Promise.all([
      readFile(fixture('codex-history.jsonl'), 'utf8'),
      readFile(fixture('codex-child-history.jsonl'), 'utf8'),
    ]);
    const root = parseCodexHistory(rootRaw, { sourceId: 'codex-root-source' });
    const child = parseCodexHistory(childRaw, { sourceId: 'codex-child-source' });
    expect(root).not.toBeNull();
    expect(child).not.toBeNull();
    const [session] = mergeParsedThreads([root!, child!]);

    expect(session?.threads).toHaveLength(2);
    expect(session?.threads[1]?.parentThreadId).toBe(session?.rootThreadId);
    expect(JSON.stringify(session)).not.toContain('REPLAYED_PARENT_MARKER');
    expect(JSON.stringify(session)).not.toContain('ENCRYPTED_MARKER');
    expect(session?.events.map((event) => event.sequence)).toEqual(
      session?.events.map((_event, index) => index),
    );
  });

  it('quarantines unsupported nonempty histories instead of returning raw data', async () => {
    const sources: HistorySource[] = [
      { id: 'unsupported', client: 'codex', path: fixture('claude-history.jsonl') },
    ];
    const result = await ingestHistorySources({ sources });
    expect(result.sessions).toEqual([]);
    expect(result.sources).toEqual([
      {
        sourceId: 'unsupported',
        client: 'codex',
        path: fixture('claude-history.jsonl'),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(result.quarantined).toEqual([
      expect.objectContaining({
        sourceId: 'unsupported',
        reason: expect.stringContaining('not Codex history'),
      }),
    ]);
  });

  it('fingerprints content deterministically without changing stable source identity', () => {
    expect(fingerprintHistoryContent('same history')).toBe(
      fingerprintHistoryContent('same history'),
    );
    expect(fingerprintHistoryContent('same history')).not.toBe(
      fingerprintHistoryContent('changed history'),
    );
  });

  it('keeps raw project resolution hints ephemeral and normalized context redacted', async () => {
    const result = await ingestHistorySources({
      sources: [
        {
          id: 'codex-resolution-fixture',
          client: 'codex',
          path: fixture('codex-history.jsonl'),
        },
      ],
    });
    const session = result.sessions[0]!;

    expect(session.projectContext?.workingDirectory).toBe('[REDACTED:PATH]');
    expect(JSON.stringify(session)).not.toContain('/home/alice/project');
    expect(result.projectResolutionHints[session.id]?.[0]).toMatchObject({
      workingDirectory: '/home/alice/project',
      gitRemote: 'https://example.com/acme/project.git',
      repositorySlug: 'acme/project',
      nameHint: 'project',
    });
  });

  it('bounds content before an adapter returns normalized events', () => {
    const raw = `${JSON.stringify({
      type: 'user',
      sessionId: 'oversized-session',
      timestamp: '2026-07-03T10:00:00.000Z',
      message: { content: 'x'.repeat(MAX_NORMALIZED_TEXT_CHARS + 1_000) },
    })}\n`;
    const parsed = parseClaudeCodeHistory(raw, { sourceId: 'oversized-source' });
    const text = parsed?.events[0]?.text;

    expect(text).toHaveLength(MAX_NORMALIZED_TEXT_CHARS);
    expect(text).toContain('[TRUNCATED:TEXT');
  });

  it('rejects a recognized container with no conversation events', () => {
    const metadataOnly = `${JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-03T10:00:00.000Z',
      payload: { id: 'metadata-only', session_id: 'metadata-only' },
    })}\n`;

    expect(() => parseCodexHistory(metadataOnly, { sourceId: 'metadata-only-source' })).toThrow(
      'no recognizable conversation events',
    );
  });

  it('treats authoritative non-Memento server metadata as a downgrade', () => {
    const parsed = parseCodexHistory(
      jsonl(
        codexMeta('server-downgrade'),
        codexUserMessage('Check the project state.'),
        {
          timestamp: '2026-07-04T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'shared-call',
            name: 'search_memory',
            arguments: '{"query":"project state"}',
          },
        },
        {
          timestamp: '2026-07-04T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'shared-call',
            output: '{"value":"provisional result"}',
          },
        },
        {
          timestamp: '2026-07-04T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'mcp_tool_call_end',
            call_id: 'shared-call',
            invocation: {
              server: 'another-server',
              tool: 'search_memory',
              arguments: { query: 'project state' },
            },
            result: { Ok: { value: 'authoritative result' } },
          },
        },
      ),
      { sourceId: 'server-downgrade-source' },
    );

    expect(parsed?.actualOperations).toEqual([]);
    expect(parsed?.events.filter((event) => event.kind === 'tool_call')).toEqual([
      expect.objectContaining({ toolCall: expect.objectContaining({ isMemento: false }) }),
    ]);
    const results = parsed?.events.filter((event) => event.kind === 'tool_result') ?? [];
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0]?.toolOutput)).toContain('authoritative result');
    expect(JSON.stringify(results[0]?.toolOutput)).not.toContain('provisional result');
  });

  it('upgrades authoritative Memento calls and keeps only their richer result', () => {
    const parsed = parseCodexHistory(
      jsonl(
        codexMeta('server-upgrade'),
        codexUserMessage('Search for the decision.'),
        {
          timestamp: '2026-07-05T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'shared-call',
            name: 'mcp__pending__search_memory',
            arguments: '{"query":"decision"}',
          },
        },
        {
          timestamp: '2026-07-05T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'shared-call',
            output: '{"result_ids":["mem_01PROVISIONAL"]}',
          },
        },
        {
          timestamp: '2026-07-05T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'mcp_tool_call_end',
            call_id: 'shared-call',
            invocation: {
              server: 'memento',
              tool: 'search_memory',
              arguments: { query: 'decision' },
            },
            result: { Ok: { result_ids: ['mem_01RICH'] } },
          },
        },
      ),
      { sourceId: 'server-upgrade-source' },
    );

    expect(parsed?.actualOperations).toEqual([
      expect.objectContaining({
        tool: 'search_memories',
        outcome: 'success',
        memoryIds: ['mem_01RICH'],
      }),
    ]);
    const results = parsed?.events.filter((event) => event.kind === 'tool_result') ?? [];
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0]?.toolOutput)).toContain('mem_01RICH');
    expect(JSON.stringify(results[0]?.toolOutput)).not.toContain('mem_01PROVISIONAL');
  });

  it('filters Claude Code meta/system user records but retains queued and SDK prompts', () => {
    const parsed = parseClaudeCodeHistory(
      jsonl(
        claudeUser('cc-filter', 'META_USER_MARKER', { isMeta: true }),
        claudeUser('cc-filter', 'SYSTEM_USER_MARKER', { promptSource: 'system' }),
        claudeUser('cc-filter', 'queued prompt', { promptSource: 'queued' }),
        claudeUser('cc-filter', 'SDK prompt', { promptSource: 'sdk' }),
      ),
      { sourceId: 'cc-filter-source' },
    );

    expect(parsed?.events.map((event) => event.text)).toEqual(['queued prompt', 'SDK prompt']);
    expect(JSON.stringify(parsed)).not.toContain('META_USER_MARKER');
    expect(JSON.stringify(parsed)).not.toContain('SYSTEM_USER_MARKER');
  });

  it('marks sessions that switch models as mixed', () => {
    const claude = parseClaudeCodeHistory(
      jsonl(
        claudeUser('cc-models', 'Use both agents.'),
        claudeAssistant('cc-models', 'model-a', 'First response.'),
        claudeAssistant('cc-models', 'model-b', 'Second response.'),
      ),
      { sourceId: 'cc-models-source' },
    );
    const codex = parseCodexHistory(
      jsonl(
        codexMeta('codex-models'),
        {
          timestamp: '2026-07-04T10:00:00.100Z',
          type: 'turn_context',
          payload: { model: 'model-a' },
        },
        {
          timestamp: '2026-07-04T10:00:00.200Z',
          type: 'turn_context',
          payload: { model: 'model-b' },
        },
        codexUserMessage('Use both agents.'),
      ),
      { sourceId: 'codex-models-source' },
    );

    expect(claude?.model).toBe('mixed');
    expect(codex?.model).toBe('mixed');
  });

  it('normalizes update scopes from nested changes and authoritative result memories', () => {
    const claude = parseClaudeCodeHistory(
      jsonl({
        type: 'assistant',
        sessionId: 'cc-update-scope',
        timestamp: '2026-07-04T10:00:00.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'cc-update-call',
              name: 'mcp__memento__update_memory',
              input: {
                id: 'mem_01UPDATE',
                changes: {
                  scope: {
                    kind: 'projects',
                    project_ids: ['prj_REQUESTED'],
                    match: 'all',
                  },
                },
              },
            },
          ],
        },
      }),
      { sourceId: 'cc-update-scope-source' },
    );
    const codex = parseCodexHistory(
      jsonl(codexMeta('codex-update-scope'), codexUserMessage('Update the memory scope.'), {
        timestamp: '2026-07-04T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'codex-update-call',
          invocation: {
            server: 'memento',
            tool: 'update_memory',
            arguments: {
              id: 'mem_01UPDATE',
              changes: {
                scope: { kind: 'projects', project_ids: ['prj_REQUESTED'] },
              },
            },
          },
          result: {
            Ok: {
              structuredContent: {
                id: 'mem_01UPDATE',
                memory: {
                  scope: {
                    kind: 'projects',
                    project_ids: ['prj_EXISTING', 'prj_REQUESTED'],
                    match: 'all',
                  },
                },
              },
            },
          },
        },
      }),
      { sourceId: 'codex-update-scope-source' },
    );

    expect(claude?.actualOperations[0]?.scope).toEqual({
      kind: 'projects',
      projectIds: ['prj_REQUESTED'],
      match: 'all',
    });
    expect(codex?.actualOperations[0]?.scope).toEqual({
      kind: 'projects',
      projectIds: ['prj_EXISTING', 'prj_REQUESTED'],
      match: 'all',
    });
  });

  it('keeps a legacy answer_memory project-name filter explicitly unresolved', () => {
    const parsed = parseCodexHistory(
      jsonl(codexMeta('codex-legacy-answer'), codexUserMessage('Find the retry decision.'), {
        timestamp: '2026-07-04T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'legacy-answer-call',
          name: 'answer_memory',
          arguments: {
            question: 'How do webhook retries avoid duplicate sends?',
            project: 'payments-api',
          },
        },
      }),
      { sourceId: 'codex-legacy-answer-source' },
    );

    expect(parsed?.actualOperations[0]).toMatchObject({
      tool: 'legacy_query',
      input: {
        question: 'How do webhook retries avoid duplicate sends?',
        project: 'payments-api',
      },
      scope: { kind: 'unknown' },
    });
  });
});

function jsonl(...records: Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function codexMeta(id: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-04T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, session_id: id },
  };
}

function codexUserMessage(message: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-04T10:00:00.500Z',
    type: 'event_msg',
    payload: { type: 'user_message', message },
  };
}

function claudeUser(
  sessionId: string,
  content: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    timestamp: '2026-07-04T10:00:00.000Z',
    message: { content },
    ...fields,
  };
}

function claudeAssistant(sessionId: string, model: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    timestamp: '2026-07-04T10:00:01.000Z',
    message: { model, content: [{ type: 'text', text }] },
  };
}

function assertPersistable(value: unknown): void {
  const persistable =
    typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'projectResolutionHints'),
        )
      : value;
  const serialized = JSON.stringify(persistable);
  expect(serialized).not.toContain('SYSTEM_MARKER');
  expect(serialized).not.toContain('DEVELOPER_MARKER');
  expect(serialized).not.toContain('ATTACHMENT_MARKER');
  expect(serialized).not.toContain('THINKING_MARKER');
  expect(serialized).not.toContain('REASONING_MARKER');
  expect(serialized).not.toContain('WORLD_STATE_MARKER');
  expect(serialized).not.toContain('LEGACY_INSTRUCTIONS_MARKER');
  expect(serialized).not.toContain('LEGACY_STATE_MARKER');
  expect(serialized).not.toContain('LEGACY_DEVELOPER_MARKER');
  expect(serialized).not.toContain('LEGACY_REASONING_MARKER');
  expect(serialized).not.toContain('LEGACY_ENCRYPTED');
  expect(detectSensitiveKinds(serialized)).toEqual([]);
}
