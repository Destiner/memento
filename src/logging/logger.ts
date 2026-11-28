// Best-effort JSONL event logger (v2.md §8).
//
// Instrumentation must never degrade the tool it observes: every write is
// fire-and-forget and swallows its own errors, so a full disk or a permission
// problem can slow metrics but never fail a create/search/get. When
// `logging_enabled` is false the logger is an inert no-op. Records are appended
// to a date-partitioned file under the logs directory; appends are line-atomic
// for the small records we write.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildEvent, logFilename, type ClientIdentity, type ToolEventFields } from './events.js';

export interface EventLogger {
  // Record one tool call. Resolves once the append settles (or is skipped); the
  // returned promise never rejects, so callers may ignore it with `void`.
  log(fields: ToolEventFields): Promise<void>;
}

export interface LoggerOptions {
  logsDir: string;
  enabled: boolean;
  serverVersion: string;
  policyVersion: string; // POLICY_VERSION of the instruction surfaces this process serves
  variant: string; // resolved MEMENTO_VARIANT, stamped on every event (§10)
  sessionId: string; // one id per server process, shared by every event it writes
  // Read per call, not once at construction: the client only declares itself
  // during the initialize handshake, which happens after the logger exists.
  client?: () => ClientIdentity | undefined;
  // Injectable for deterministic tests; defaults to wall-clock.
  now?: () => number;
}

const accountEvents = new AsyncLocalStorage<{
  logsDir: string;
  append: (filename: string, line: string) => void;
}>();

export function withAccountEventLog<T>(
  logsDir: string,
  append: (filename: string, line: string) => void,
  operation: () => T,
): T {
  return accountEvents.run({ logsDir, append }, operation);
}

const NOOP_LOGGER: EventLogger = { log: () => Promise.resolve() };

export function createLogger(options: LoggerOptions): EventLogger {
  if (!options.enabled) {
    return NOOP_LOGGER;
  }

  const now = options.now ?? Date.now;
  const account = accountEvents.getStore();

  return {
    async log(fields) {
      try {
        const event = buildEvent(fields, {
          serverVersion: options.serverVersion,
          policyVersion: options.policyVersion,
          variant: options.variant,
          sessionId: options.sessionId,
          client: options.client?.(),
          now: now(),
        });
        const filename = logFilename(event.timestamp);
        const line = JSON.stringify(event) + '\n';
        if (account?.logsDir === options.logsDir) {
          account.append(filename, line);
          return;
        }
        const file = join(options.logsDir, filename);
        await mkdir(options.logsDir, { recursive: true });
        await appendFile(file, line, 'utf8');
      } catch {
        // Best-effort: instrumentation failures must not surface to the caller.
      }
    },
  };
}
