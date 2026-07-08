import { describe, expect, it } from 'vitest';

import { logFilename, LOG_FILE_PATTERN } from '../../src/logging/events.js';

// Bind the writer to the readers. Every event-log reader (the server report and
// the test harness) filters partitions by LOG_FILE_PATTERN; if the partition
// format ever diverges from what logFilename writes, a reader would silently match
// zero files. This test fails the moment the two drift.
describe('log partition format', () => {
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
