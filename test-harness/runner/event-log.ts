// Memento event-log parser (docs/harness-spec.md §5; src/logging/events.ts).
//
// The Memento server writes one JSON event per tool call — success *and* error —
// to date-partitioned files under `$MEMENTO_HOME/logs/`. This is the authoritative
// record of which Memento tools a session called: cleaner than the Claude Code
// transcript, whose `--output-format json` emits only the final result object, not
// the intermediate tool_use blocks. Both false-positive rates (§5.1) and the
// diagnostics (§5.4) are derived from these events, so the runner stores the whole
// list per rep (§8.2 raw.memento_calls) and the report re-scores from it.
//
// Reading is lenient: a malformed line is skipped, not fatal, so a partially-
// written log (the logger is fire-and-forget) never invalidates a rep.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The event-file partition format is the server's, imported from the one place
// that also produces it (src/logging/events.ts): if the server changes filenames
// or partitioning, this matcher moves with it instead of silently matching zero
// files and deflating every rep to "no memento calls" (harness-spec §5).
import { LOG_FILE_PATTERN, LOG_SCHEMA_VERSION } from '../../src/logging/events.js';

// The non-sensitive fields the scorer keeps from each event. Names only — the log
// never records raw query/body text (v2.md §8), and neither do we.
export interface MementoCall {
  session_id: string; // one bundled-server process; a rep normally has exactly one
  tool: string; // resolve_project | search_memories | get_memory | create_memory | ...
  outcome: string; // success | error
  server_version: string;
  policy_version: string;
  variant: string; // resolved MEMENTO_VARIANT the server logged (§10 contamination guard)
  log_schema_version: typeof LOG_SCHEMA_VERSION;
  result_outcome?: string; // created | duplicate_candidates | exact_match | ...
  memory_type?: string;
  scope_kind?: string;
  project_count?: number;
  result_count?: number; // search_memories only — hits returned
  result_ids?: string[]; // search_memories hits, in rank order
  memory_id?: string; // get/create/update/archive join key
}

const CAPTURE_TOOLS = new Set(['create_memory', 'update_memory']);

/** Every Memento tool call the session made, oldest partition first. */
export function readMementoCalls(mementoHome: string): MementoCall[] {
  const logsDir = join(mementoHome, 'logs');
  if (!existsSync(logsDir)) return [];

  const calls: MementoCall[] = [];
  const files = readdirSync(logsDir)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(logsDir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const call = parseLine(line);
      if (call) calls.push(call);
    }
  }
  return calls;
}

function parseLine(line: string): MementoCall | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    typeof obj.event_id !== 'string' ||
    typeof obj.timestamp !== 'string' ||
    typeof obj.session_id !== 'string' ||
    typeof obj.tool !== 'string' ||
    typeof obj.outcome !== 'string' ||
    typeof obj.server_version !== 'string' ||
    typeof obj.policy_version !== 'string' ||
    typeof obj.variant !== 'string' ||
    obj.log_schema_version !== LOG_SCHEMA_VERSION ||
    typeof obj.latency_ms !== 'number'
  ) {
    return null;
  }
  return {
    session_id: obj.session_id,
    tool: obj.tool,
    outcome: obj.outcome,
    server_version: obj.server_version,
    policy_version: obj.policy_version,
    variant: obj.variant,
    log_schema_version: LOG_SCHEMA_VERSION,
    ...(typeof obj.result_outcome === 'string' ? { result_outcome: obj.result_outcome } : {}),
    ...(typeof obj.memory_type === 'string' ? { memory_type: obj.memory_type } : {}),
    ...(typeof obj.scope_kind === 'string' ? { scope_kind: obj.scope_kind } : {}),
    ...(typeof obj.project_count === 'number' ? { project_count: obj.project_count } : {}),
    ...(typeof obj.result_count === 'number' ? { result_count: obj.result_count } : {}),
    ...(stringArray(obj.result_ids) ? { result_ids: stringArray(obj.result_ids) } : {}),
    ...(typeof obj.memory_id === 'string' ? { memory_id: obj.memory_id } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

/**
 * The resolved MEMENTO_VARIANT the server stamped on this rep's events, or null if
 * there were no Memento calls. Lets the runner assert the server actually ran the
 * variant the config declared — a blanked/corrupted env would otherwise poison a
 * baseline undetectably (harness-spec §10).
 */
export function loggedVariant(calls: MementoCall[]): string | null {
  return calls[0]?.variant ?? null;
}

/** Distinct bundled-server processes represented in a rep's private event log. */
export function serverSessionIds(calls: MementoCall[]): string[] {
  return [...new Set(calls.map((call) => call.session_id))];
}

/** ≥1 Memento tool call — a false positive for should-not-retrieve (§5.1). */
export function anyMementoCall(calls: MementoCall[]): boolean {
  return calls.length > 0;
}

/** ≥1 create/update *attempt*, any outcome — the false positive for
 *  should-not-capture (§5.1: "any create/update call"): the agent tried to write
 *  where nothing durable emerged, whether or not the write happened to land. */
export function anyCaptureAttempt(calls: MementoCall[]): boolean {
  return calls.some((call) => CAPTURE_TOOLS.has(call.tool));
}

/** ≥1 *successful* create/update — the C1 gate for a good capture (§5.2). A
 *  failed write leaves no durable memory, so it cannot be a good capture. */
export function anyCaptureSuccess(calls: MementoCall[]): boolean {
  return calls.some((call) => {
    if (call.outcome !== 'success') return false;
    if (call.tool === 'update_memory') return call.memory_id !== undefined;
    return (
      call.tool === 'create_memory' &&
      call.result_outcome === 'created' &&
      call.memory_id !== undefined
    );
  });
}

/** Whether this exact memory was created or updated during the rep. */
export function memoryWasStored(calls: MementoCall[], memoryId: string | null): boolean {
  if (memoryId === null) return false;
  return calls.some((call) => {
    if (call.memory_id !== memoryId || call.outcome !== 'success') return false;
    return (
      call.tool === 'update_memory' ||
      (call.tool === 'create_memory' && call.result_outcome === 'created')
    );
  });
}

/** Share of non-empty searches followed by opening one of that search's hits. */
export function searchToGetRate(calls: MementoCall[]): number | null {
  let eligible = 0;
  let opened = 0;
  for (let i = 0; i < calls.length; i++) {
    const search = calls[i]!;
    if (search.tool !== 'search_memories' || !search.result_ids?.length) continue;
    eligible++;
    const ids = new Set(search.result_ids);
    if (
      calls
        .slice(i + 1)
        .some(
          (call) =>
            call.tool === 'get_memory' && call.memory_id !== undefined && ids.has(call.memory_id),
        )
    ) {
      opened++;
    }
  }
  return eligible === 0 ? null : opened / eligible;
}
