import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadEvents } from '../../src/report/load.js';

const LOGS_DIR = fileURLToPath(new URL('../fixtures/logs', import.meta.url));

describe('loadEvents', () => {
  it('reads matching files in chronological order, skipping malformed and blank lines', async () => {
    const events = await loadEvents(LOGS_DIR);

    // 8 valid on day 1 (one blank + one garbage line dropped) + 9 on day 2.
    expect(events).toHaveLength(17);
    // Files sort by name, so 07-01 events precede 07-02 events.
    expect(events[0]!.event_id).toBe('evt_01A');
    expect(events.at(-1)!.event_id).toBe('evt_02Z');
    // The .txt file that is not an events-*.jsonl log is ignored.
    expect(events.every((e) => e.event_id.startsWith('evt_'))).toBe(true);
  });

  it('returns an empty array when the logs directory does not exist', async () => {
    const events = await loadEvents(
      fileURLToPath(new URL('../fixtures/does-not-exist', import.meta.url)),
    );
    expect(events).toEqual([]);
  });
});
