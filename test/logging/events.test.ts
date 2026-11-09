import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildEvent, logFilename, LOG_FILE_PATTERN } from '../../src/logging/events.js';
import { loadEvents } from '../../src/report/load.js';

// Bind the writer to the readers. Every event-log reader (the server report and
// the test harness) filters partitions by LOG_FILE_PATTERN; if the partition
// format ever diverges from what logFilename writes, a reader would silently match
// zero files. This test fails the moment the two drift.
describe('log partition format', () => {
  it('loads v2 search events without optional diagnostics alongside enriched events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memento-log-compat-'));
    try {
      const old = buildEvent(
        { tool: 'search_memories', outcome: 'success', latency_ms: 1, result_count: 0 },
        {
          serverVersion: '0.4.0',
          policyVersion: 'test',
          variant: 'plain',
          sessionId: 'ses_test',
          now: 0,
        },
      );
      const enriched = {
        ...old,
        search_ranker: 'lexical-evidence-v1',
        result_scores: [],
        search_limit: 5,
        search_statuses: ['active'],
      };
      expect(old.log_schema_version).toBe(2);
      await writeFile(
        join(dir, logFilename(old.timestamp)),
        `${JSON.stringify(old)}\n${JSON.stringify(enriched)}\n`,
      );
      expect(await loadEvents(dir)).toEqual([old, enriched]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('every filename logFilename writes matches LOG_FILE_PATTERN', () => {
    for (const iso of ['2026-01-01T00:00:00Z', '2026-07-04T15:03:12Z', '2026-12-31T23:59:59Z']) {
      expect(LOG_FILE_PATTERN.test(logFilename(iso))).toBe(true);
    }
  });

  it('does not match unrelated files in the logs dir', () => {
    for (const name of [
      'events.jsonl',
      'events-2026-07.jsonl',
      'index.db',
      'events-2026-07-04.json',
    ]) {
      expect(LOG_FILE_PATTERN.test(name)).toBe(false);
    }
  });
});
