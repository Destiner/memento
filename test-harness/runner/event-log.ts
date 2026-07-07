// Memento event-log parser (harness-spec §5; implementer-spec §13).
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

// The non-sensitive fields the scorer keeps from each event. Names only — the log
// never records raw query/body text (§13 privacy defaults), and neither do we.
export interface MementoCall {
  tool: string; // search_memory | read_memory | create_memory | update_memory | answer_memory
  outcome: string; // success | error
  memory_type?: string; // create_memory only
  memory_scope?: string; // create_memory only
  result_count?: number; // search_memory only — hits returned (empty-search-rate diagnostic, §5.4)
}

const CAPTURE_TOOLS = new Set(['create_memory', 'update_memory']);
const EVENT_FILE_RE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Every Memento tool call the session made, oldest partition first. */
export function readMementoCalls(mementoHome: string): MementoCall[] {
  const logsDir = join(mementoHome, 'logs');
  if (!existsSync(logsDir)) return [];

  const calls: MementoCall[] = [];
  const files = readdirSync(logsDir)
    .filter((name) => EVENT_FILE_RE.test(name))
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
  if (typeof obj.tool !== 'string') return null;
  return {
    tool: obj.tool,
    outcome: typeof obj.outcome === 'string' ? obj.outcome : 'unknown',
    ...(typeof obj.memory_type === 'string' ? { memory_type: obj.memory_type } : {}),
    ...(typeof obj.memory_scope === 'string' ? { memory_scope: obj.memory_scope } : {}),
    ...(typeof obj.result_count === 'number' ? { result_count: obj.result_count } : {}),
  };
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
  return calls.some((call) => CAPTURE_TOOLS.has(call.tool) && call.outcome === 'success');
}
