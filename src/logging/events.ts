// Event shape for the local instrumentation log (v2.md §8).
//
// One JSON object per line answers "are agents using the tools, which ones, with
// what result, and does anything get read back later?" The privacy boundary is
// explicit: we log lengths, counts, controlled-vocabulary values, and *opaque
// ids* — never human-readable content. No query text, no titles, no bodies, no
// archive reasons, no filesystem paths. An id is only meaningful next to the
// local store it came from, which is the same machine the log lives on.

import { generateEventId } from '../store/id.js';
import { isoSeconds } from '../store/time.js';

export type ToolOutcome = 'success' | 'error';

// Bumped when the record changes in a way a reader must notice. Schema 2 includes
// session ids, the policy version, client identity, and record ids. Readers accept
// only this complete envelope.
export const LOG_SCHEMA_VERSION = 2;

// Identity the client declared during the MCP initialize handshake. Both fields
// are client-supplied strings, so both are length-capped before they reach disk.
export interface ClientIdentity {
  name?: string;
  version?: string;
}

const CLIENT_FIELD_MAX = 64;

// Per-call fields a tool handler contributes. All optional and non-sensitive:
// derived counts, controlled-vocabulary values, the names (not values) of the
// filters a search used, and opaque record ids.
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
  // the ids a search returned, in rank order. Turns search → get_memory from a
  // coincidence of counts into a real funnel: a later get of one of these ids is
  // that search being acted on, and a get of anything else is not.
  result_ids?: string[];
  // any scoped call: the kind, how many projects, and which
  scope_kind?: string;
  project_count?: number;
  project_ids?: string[];
  // create_memory / update_memory
  memory_type?: string;
  dropped_evidence_count?: number;
  verification?: string;
  mark_verified?: boolean;
  // the record a call created, read, updated, or archived — the join key for
  // "was this memory ever used again, and in a later session?"
  memory_id?: string;
  // the two gated creates: what the operation decided, and what it offered
  result_outcome?: string;
  candidate_count?: number;
  candidate_ids?: string[];
  forced?: boolean;
  // resolve_project
  matched_on?: string;
  suggestion_count?: number;
  // errors — the canonical code only, never the message (which may quote input)
  error_code?: string;
}

// A fully-assembled log record: the caller's fields plus the envelope shared by
// every event. `event_id`, `timestamp`, and `session_id` come first for
// scannability.
//
// `session_id` groups one server process (see generateSessionId). `variant`
// records the resolved MEMENTO_VARIANT, so a reader can tell which knob arm
// produced the events — and a harness rep can assert it ran the arm its config
// declared, catching a blanked/corrupted env before it poisons a baseline
// (harness-spec §10). `policy_version` moves independently of `server_version`:
// instruction text can change with no code change and vice versa, and a
// comparison that conflates the two credits the wrong variable.
//
export interface LoggedEvent extends ToolEventFields {
  event_id: string;
  timestamp: string;
  session_id: string;
  server_version: string;
  policy_version: string;
  variant: string;
  client_name?: string;
  client_version?: string;
  log_schema_version: typeof LOG_SCHEMA_VERSION;
}

export interface EventMeta {
  serverVersion: string;
  policyVersion: string;
  variant: string;
  sessionId: string;
  // Absent until the client completes the initialize handshake.
  client?: ClientIdentity;
  now: number;
  eventId?: string;
}

// Assemble a complete record from a handler's fields. Pure and deterministic
// given `now`/`eventId`, so both the logger and its tests share one shape.
export function buildEvent(fields: ToolEventFields, meta: EventMeta): LoggedEvent {
  return {
    event_id: meta.eventId ?? generateEventId(meta.now),
    timestamp: isoSeconds(meta.now),
    session_id: meta.sessionId,
    ...fields,
    server_version: meta.serverVersion,
    policy_version: meta.policyVersion,
    variant: meta.variant,
    ...capped('client_name', meta.client?.name),
    ...capped('client_version', meta.client?.version),
    log_schema_version: LOG_SCHEMA_VERSION,
  };
}

// Omit the key entirely when there is nothing to record: an absent field reads as
// "the client did not say", where an empty string reads as a client that named
// itself the empty string.
function capped<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  return { [key]: trimmed.slice(0, CLIENT_FIELD_MAX) } as Record<K, string>;
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
