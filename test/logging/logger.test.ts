import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEvent, logFilename } from '../../src/logging/events.js';
import { createLogger } from '../../src/logging/logger.js';

const tempDirs: string[] = [];

async function makeLogsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memento-logs-'));
  tempDirs.push(dir);
  return join(dir, 'logs');
}

// 2026-07-04T15:03:12Z
const FIXED_NOW = Date.UTC(2026, 6, 4, 15, 3, 12);

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
      { tool: 'search_memory', outcome: 'success', latency_ms: 42, result_count: 3 },
      { serverVersion: '0.1.0', now: FIXED_NOW, eventId: 'evt_TEST' },
    );

    expect(event).toEqual({
      event_id: 'evt_TEST',
      timestamp: '2026-07-04T15:03:12Z',
      tool: 'search_memory',
      outcome: 'success',
      latency_ms: 42,
      result_count: 3,
      server_version: '0.1.0',
    });
  });

  it('generates a sortable evt_ id when none is supplied', () => {
    const event = buildEvent(
      { tool: 'read_memory', outcome: 'error', latency_ms: 1, error_code: 'not_found' },
      { serverVersion: '0.1.0', now: FIXED_NOW },
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
    const logger = createLogger({
      logsDir,
      enabled: true,
      serverVersion: '0.1.0',
      now: () => FIXED_NOW,
    });

    await logger.log({
      tool: 'create_memory',
      outcome: 'success',
      latency_ms: 5,
      memory_type: 'decision',
    });
    await logger.log({ tool: 'search_memory', outcome: 'success', latency_ms: 8, result_count: 0 });

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
      memory_type: 'decision',
      server_version: '0.1.0',
    });
    expect(first.event_id).toMatch(/^evt_/);
    expect(first.timestamp).toBe('2026-07-04T15:03:12Z');
  });

  it('is an inert no-op when logging is disabled (writes nothing)', async () => {
    const logsDir = await makeLogsDir();
    const logger = createLogger({ logsDir, enabled: false, serverVersion: '0.1.0' });

    await logger.log({ tool: 'read_memory', outcome: 'success', latency_ms: 1 });

    await expect(readdir(logsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never rejects when the append fails', async () => {
    // Point the logs "dir" at a path whose parent is a file, so mkdir/append fail.
    const logsDir = await makeLogsDir();
    const blockedDir = join(logsDir, 'not-a-dir-parent');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(logsDir, { recursive: true }).then(() => fs.writeFile(blockedDir, 'x')),
    );
    const logger = createLogger({
      logsDir: join(blockedDir, 'logs'),
      enabled: true,
      serverVersion: '0.1.0',
    });

    await expect(
      logger.log({ tool: 'read_memory', outcome: 'success', latency_ms: 1 }),
    ).resolves.toBeUndefined();
  });
});
