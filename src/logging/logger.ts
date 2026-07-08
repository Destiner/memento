// Best-effort JSONL event logger (§13).
//
// Instrumentation must never degrade the tool it observes: every write is
// fire-and-forget and swallows its own errors, so a full disk or a permission
// problem can slow metrics but never fail a create/search/answer. When
// `logging_enabled` is false the logger is an inert no-op. Records are appended
// to a date-partitioned file under the logs directory; appends are line-atomic
// for the small records we write.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildEvent, logFilename, type ToolEventFields } from './events.js';

export interface EventLogger {
  // Record one tool call. Resolves once the append settles (or is skipped); the
  // returned promise never rejects, so callers may ignore it with `void`.
  log(fields: ToolEventFields): Promise<void>;
}

export interface LoggerOptions {
  logsDir: string;
  enabled: boolean;
  serverVersion: string;
  variant: string; // resolved MEMENTO_VARIANT, stamped on every event (§10)
  // Injectable for deterministic tests; defaults to wall-clock.
  now?: () => number;
}

const NOOP_LOGGER: EventLogger = { log: () => Promise.resolve() };

export function createLogger(options: LoggerOptions): EventLogger {
  if (!options.enabled) {
    return NOOP_LOGGER;
  }

  const now = options.now ?? Date.now;

  return {
    async log(fields) {
      try {
        const event = buildEvent(fields, {
          serverVersion: options.serverVersion,
          variant: options.variant,
          now: now(),
        });
        const file = join(options.logsDir, logFilename(event.timestamp));
        await mkdir(options.logsDir, { recursive: true });
        await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
      } catch {
        // Best-effort: instrumentation failures must not surface to the caller.
      }
    },
  };
}
