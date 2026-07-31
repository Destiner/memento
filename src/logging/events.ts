// Event shape for the local instrumentation log (§13).
//
// One JSON object per line answers "are agents using the tools, which ones, and
// with what result?" without ever recording memory content. Privacy is a hard
// constraint: we log lengths, filters, controlled-vocabulary values, and derived
// signals — never the raw query, question, or body text (§13 "Privacy defaults").

import { generateEventId } from '../store/id.js';
import { isoSeconds } from '../store/time.js';

export type ToolOutcome = 'success' | 'error';

// Per-call fields a tool handler contributes. All optional and non-sensitive:
// derived counts, controlled-vocabulary values, and the names (not values) of
// the filters a search used.
export interface ToolEventFields {
  tool: string;
  outcome: ToolOutcome;
  latency_ms: number;
  // search_memories
  result_count?: number;
  query_length?: number;
  filters_used?: string[];
  query_id?: string;
  match_mode?: string;
  // any scoped call: the kind, and how many projects, never which
  scope_kind?: string;
  project_count?: number;
  // create_memory / update_memory
  memory_type?: string;
  dropped_evidence_count?: number;
  verification?: string;
  mark_verified?: boolean;
  // the two gated creates: what the operation decided, and what it offered
  result_outcome?: string;
  candidate_count?: number;
  forced?: boolean;
  // resolve_project
  matched_on?: string;
  suggestion_count?: number;
  // errors — the canonical code only, never the message (which may quote input)
  error_code?: string;
}

// A fully-assembled log record: the caller's fields plus the envelope shared by
// every event. `event_id` and `timestamp` come first for scannability. `variant`
// records the resolved MEMENTO_VARIANT the server ran, so a reader can tell which
// knob arm produced the events — and a harness rep can assert it ran the arm its
// config declared, catching a blanked/corrupted env before it poisons a baseline
// (harness-spec §10). Optional on the type because logs written before it existed
// lack it; buildEvent always sets it, so every new event carries it.
export interface LoggedEvent extends ToolEventFields {
  event_id: string;
  timestamp: string;
  server_version: string;
  variant?: string;
}

// Assemble a complete record from a handler's fields. Pure and deterministic
// given `now`/`eventId`, so both the logger and its tests share one shape.
export function buildEvent(
  fields: ToolEventFields,
  meta: { serverVersion: string; variant: string; now: number; eventId?: string },
): LoggedEvent {
  return {
    event_id: meta.eventId ?? generateEventId(meta.now),
    timestamp: isoSeconds(meta.now),
    ...fields,
    server_version: meta.serverVersion,
    variant: meta.variant,
  };
}

// The date-partition filename for an event's timestamp: `events-YYYY-MM-DD.jsonl`
// (UTC, matching the ISO timestamps). One file per day keeps logs greppable and
// trivially prunable.
export function logFilename(timestamp: string): string {
  return `events-${timestamp.slice(0, 10)}.jsonl`;
}

// Matches the files `logFilename` produces. The single source of truth every
// reader filters partitions by — the server report (src/report/load.ts) and the
// test harness (test-harness/runner/event-log.ts) both import it, so a change to
// the partition format lands here and can't silently leave a reader matching zero
// files (a binding test asserts logFilename's output satisfies it).
export const LOG_FILE_PATTERN = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;
