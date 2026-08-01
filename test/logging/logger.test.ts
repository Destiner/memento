import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEvent,
  logFilename,
  LOG_SCHEMA_VERSION,
  type ClientIdentity,
  type EventMeta,
} from '../../src/logging/events.js';
import { createLogger } from '../../src/logging/logger.js';

const tempDirs: string[] = [];

async function makeLogsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memento-logs-'));
  tempDirs.push(dir);
  return join(dir, 'logs');
}

// 2026-07-04T15:03:12Z
const FIXED_NOW = Date.UTC(2026, 6, 4, 15, 3, 12);

const META: EventMeta = {
  serverVersion: '0.3.2',
  policyVersion: '2.1.0',
  variant: 'plain',
  sessionId: 'ses_TEST',
  now: FIXED_NOW,
};

const LOGGER_OPTIONS = {
  enabled: true,
  serverVersion: '0.3.2',
  policyVersion: '2.1.0',
  variant: 'plain',
  sessionId: 'ses_TEST',
  now: () => FIXED_NOW,
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })),
      ),
  );
});

describe('buildEvent', () => {
  it('wraps fields in the shared envelope with second-precision timestamp', () => {
    const event = buildEvent(
      { tool: 'search_memories', outcome: 'success', latency_ms: 42, result_count: 3 },
      { ...META, eventId: 'evt_TEST' },
    );

    expect(event).toEqual({
      event_id: 'evt_TEST',
      timestamp: '2026-07-04T15:03:12Z',
      session_id: 'ses_TEST',
      tool: 'search_memories',
      outcome: 'success',
      latency_ms: 42,
      result_count: 3,
      server_version: '0.3.2',
      policy_version: '2.1.0',
      variant: 'plain',
      log_schema_version: LOG_SCHEMA_VERSION,
    });
  });

  it('records client identity when the handshake supplied it', () => {
    const event = buildEvent(
      { tool: 'get_memory', outcome: 'success', latency_ms: 1 },
      { ...META, client: { name: 'claude-code', version: '2.1.4' } },
    );
    expect(event.client_name).toBe('claude-code');
    expect(event.client_version).toBe('2.1.4');
  });

  it('omits client fields entirely rather than writing empty strings', () => {
    const event = buildEvent(
      { tool: 'get_memory', outcome: 'success', latency_ms: 1 },
      { ...META, client: { name: '   ', version: undefined } },
    );
    expect(event).not.toHaveProperty('client_name');
    expect(event).not.toHaveProperty('client_version');
  });

  it('caps client-supplied strings so a hostile client cannot bloat the log', () => {
    const event = buildEvent(
      { tool: 'get_memory', outcome: 'success', latency_ms: 1 },
      { ...META, client: { name: 'x'.repeat(500), version: 'y'.repeat(500) } },
    );
    expect(event.client_name).toHaveLength(64);
    expect(event.client_version).toHaveLength(64);
  });

  it('generates a sortable evt_ id when none is supplied', () => {
    const event = buildEvent(
      { tool: 'get_memory', outcome: 'error', latency_ms: 1, error_code: 'not_found' },
      META,
    );
    expect(event.event_id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('logFilename', () => {
  it('partitions by the UTC date of the timestamp', () => {
    expect(logFilename('2026-07-04T15:03:12Z')).toBe('events-2026-07-04.jsonl');
  });
});

describe('createLogger', () => {
  it('appends one JSON line per call to a date-partitioned file', async () => {
    const logsDir = await makeLogsDir();
    const logger = createLogger({ ...LOGGER_OPTIONS, logsDir });

    await logger.log({
      tool: 'create_memory',
      outcome: 'success',
      latency_ms: 5,
      memory_type: 'decision_history',
      memory_id: 'mem_ONE',
    });
    await logger.log({
      tool: 'search_memories',
      outcome: 'success',
      latency_ms: 8,
      result_count: 0,
    });

    const files = await readdir(logsDir);
    expect(files).toEqual(['events-2026-07-04.jsonl']);

    const raw = await readFile(join(logsDir, files[0]!), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      tool: 'create_memory',
      outcome: 'success',
      latency_ms: 5,
      memory_type: 'decision_history',
      memory_id: 'mem_ONE',
      session_id: 'ses_TEST',
      server_version: '0.3.2',
      policy_version: '2.1.0', // moves independently of the server version (§8)
      variant: 'plain', // resolved MEMENTO_VARIANT stamped on every event (§10)
      log_schema_version: LOG_SCHEMA_VERSION,
    });
    expect(first.event_id).toMatch(/^evt_/);
    expect(first.timestamp).toBe('2026-07-04T15:03:12Z');
  });

  it('reads client identity per call, not once at construction', async () => {
    const logsDir = await makeLogsDir();
    // The MCP initialize handshake lands after the logger is built, so a value
    // captured at construction would be undefined forever.
    const handshake: { client?: ClientIdentity } = {};
    const logger = createLogger({ ...LOGGER_OPTIONS, logsDir, client: () => handshake.client });

    await logger.log({ tool: 'get_memory', outcome: 'success', latency_ms: 1 });
    handshake.client = { name: 'codex', version: '0.9.0' };
    await logger.log({ tool: 'get_memory', outcome: 'success', latency_ms: 1 });

    const raw = await readFile(join(logsDir, 'events-2026-07-04.jsonl'), 'utf8');
    const [before, after] = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(before).not.toHaveProperty('client_name');
    expect(after.client_name).toBe('codex');
  });

  it('is an inert no-op when logging is disabled (writes nothing)', async () => {
    const logsDir = await makeLogsDir();
    const logger = createLogger({ ...LOGGER_OPTIONS, logsDir, enabled: false });

    await logger.log({ tool: 'get_memory', outcome: 'success', latency_ms: 1 });

    await expect(readdir(logsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never rejects when the append fails', async () => {
    // Point the logs "dir" at a path whose parent is a file, so mkdir/append fail.
    const logsDir = await makeLogsDir();
    const blockedDir = join(logsDir, 'not-a-dir-parent');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(logsDir, { recursive: true }).then(() => fs.writeFile(blockedDir, 'x')),
    );
    const logger = createLogger({ ...LOGGER_OPTIONS, logsDir: join(blockedDir, 'logs') });

    await expect(
      logger.log({ tool: 'get_memory', outcome: 'success', latency_ms: 1 }),
    ).resolves.toBeUndefined();
  });
});
