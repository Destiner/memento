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
  // search_memory
  result_count?: number;
  query_length?: number;
  filters_used?: string[];
  query_id?: string;
  // create_memory
  memory_type?: string;
  memory_scope?: string;
  // answer_memory
  source_count?: number;
  question_length?: number;
  confidence?: string;
  // errors — the canonical code only, never the message (which may quote input)
  error_code?: string;
}

// A fully-assembled log record: the caller's fields plus the envelope shared by
// every event. `event_id` and `timestamp` come first for scannability.
export interface LoggedEvent extends ToolEventFields {
  event_id: string;
  timestamp: string;
  server_version: string;
}

// Assemble a complete record from a handler's fields. Pure and deterministic
// given `now`/`eventId`, so both the logger and its tests share one shape.
export function buildEvent(
  fields: ToolEventFields,
  meta: { serverVersion: string; now: number; eventId?: string },
): LoggedEvent {
  return {
    event_id: meta.eventId ?? generateEventId(meta.now),
    timestamp: isoSeconds(meta.now),
    ...fields,
    server_version: meta.serverVersion,
  };
}

// The date-partition filename for an event's timestamp: `events-YYYY-MM-DD.jsonl`
// (UTC, matching the ISO timestamps). One file per day keeps logs greppable and
// trivially prunable.
export function logFilename(timestamp: string): string {
  return `events-${timestamp.slice(0, 10)}.jsonl`;
}
