// Read the date-partitioned JSONL event logs back into memory for the report.
//
// Tolerant by design: a missing logs directory is an empty stream (no runs yet),
// and a malformed line is skipped rather than aborting the whole report — the
// log is append-only instrumentation, not a transactional store.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { LOG_FILE_PATTERN, type LoggedEvent } from '../logging/events.js';

export async function loadEvents(logsDir: string): Promise<LoggedEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  // Filenames sort chronologically, so events come back in date order.
  const files = entries.filter((name) => LOG_FILE_PATTERN.test(name)).sort();

  const events: LoggedEvent[] = [];
  for (const file of files) {
    const raw = await readFile(join(logsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as LoggedEvent);
      } catch {
        // Skip a torn or hand-mangled line; keep the rest of the report intact.
      }
    }
  }
  return events;
}
