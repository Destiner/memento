// Aggregate raw tool-call events into the v2.md §8 dashboard metrics.
//
// Pure and log-only: every number here is derived solely from the JSONL event
// stream. Anything that needs the memory store — project names, staleness, which
// memories were never read — lives in store-view.ts and is joined at render time,
// so this module stays a faithful, trivially testable view of instrumented usage.
//
// Two things the log genuinely cannot answer, and which are therefore absent
// rather than approximated: what share of *eligible* sessions searched, and what
// share of *eligible* learnings became memories. Eligibility is a judgement about
// work that did not happen, which is the retrospective pipeline's job (§9). What
// is here are the observable proxies — did a session search at all, what did it
// reach for first, and was anything it stored ever read back.

import type { LoggedEvent } from '../logging/events.js';

export interface LatencyStats {
  count: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface Distribution {
  mean: number;
  p50: number;
  p90: number;
  max: number;
}

export interface DayCount {
  date: string;
  count: number;
}

export interface DayToolCount {
  date: string;
  total: number;
  byTool: Record<string, number>;
}

export interface CumulativeDay {
  date: string;
  created: number;
  cumulative: number;
}

export interface SessionMetrics {
  sessionCount: number;
  callsPerSession: Distribution;
  // A guardrail, not a success metric (§8): a session searching ten times is a
  // signal to read, not a win.
  searchesPerSession: Distribution;
  sessionsWithSearch: number;
  sessionsWithWrite: number;
  // What each session called first — the closest the log gets to "did memory
  // enter the work, or was it an afterthought?"
  firstCallByTool: Record<string, number>;
  // Events predating session ids (log_schema_version < 2). Excluded from every
  // number above rather than pooled into one phantom session.
  unsessionedCalls: number;
}

export interface FunnelMetrics {
  searches: number;
  searchZeroResultRate: number;
  // Share of non-empty searches whose own results were opened later in the same
  // session. This is the real search → get_memory funnel: it matches the ids a
  // search returned against the ids later fetched, so an unrelated get cannot
  // inflate it.
  searchActedOnRate: number;
  // Gets of a memory no preceding search in that session offered — a direct id
  // from an earlier session, or a hand-copied one.
  unpromptedGets: number;
  resolveOutcomes: Record<string, number>;
  // Successful project creations ÷ `not_found` resolutions. Near 1 means the
  // registry is still filling up; well below 1 means agents resolve and move on.
  createAfterNotFoundRate: number;
}

export interface WriteMetrics {
  createAttempts: number;
  created: number;
  updated: number;
  archived: number;
  // Share of create attempts the near-duplicate gate answered with candidates
  // instead of writing. High is not automatically bad — it is the gate working —
  // but it should fall as agents learn to search first.
  dedupeGateRate: number;
  projectDedupeGateRate: number;
  forcedCreates: number;
  createToUpdateRatio: number;
  archiveToCreateRatio: number;
  memoriesByType: Record<string, number>;
  memoriesByScope: Record<string, number>;
}

export interface RetrievedMemory {
  memory_id: string;
  reads: number;
}

export interface ReuseMetrics {
  // Memories created within the log window, so the denominators below are honest:
  // a memory created before logging began cannot be shown to have been reused.
  createdInWindow: number;
  retrievedLater: number;
  retrievedInLaterSession: number;
  // The number that matters most for whether memory is worth keeping: a memory
  // read only in the session that wrote it has not yet proved anything.
  retrievedInLaterSessionRate: number;
  topRetrieved: RetrievedMemory[];
  // Every memory id the log shows a successful read of, not just the top ten.
  // The store view joins against this to find memories nobody ever opened, so it
  // has to be the complete set.
  retrievedIds: string[];
}

export interface Segment {
  variant: string;
  policyVersion: string;
  serverVersion: string;
  client: string;
  calls: number;
  sessions: number;
  searchActivationRate: number;
  writeActivationRate: number;
  dedupeGateRate: number;
  searchZeroResultRate: number;
}

export interface ProjectActivity {
  project_id: string;
  calls: number;
  searches: number;
  writes: number;
}

export interface Metrics {
  totalCalls: number;
  outcomeCounts: { success: number; error: number };
  callsByTool: Record<string, number>;
  callsByDay: DayToolCount[];
  errorsByCode: Record<string, number>;
  memoriesCreatedByDay: CumulativeDay[];
  totalMemoriesCreated: number;
  searchCallsByDay: DayCount[];
  latencyByTool: Record<string, LatencyStats>;
  sessions: SessionMetrics;
  funnel: FunnelMetrics;
  writes: WriteMetrics;
  reuse: ReuseMetrics;
  // Every headline number split by the four axes that move independently. Without
  // this a model upgrade and an instruction rewrite are indistinguishable (§8).
  segments: Segment[];
  projectActivity: ProjectActivity[];
  dateRange: { first: string; last: string } | null;
}

const SEARCH_TOOL = 'search_memories';
const GET_TOOL = 'get_memory';
const UNKNOWN = '(unknown)';

const dayOf = (event: LoggedEvent): string => event.timestamp.slice(0, 10);

// A create that returned candidates is a successful call that wrote nothing.
const isCreated = (event: LoggedEvent): boolean =>
  event.tool === 'create_memory' &&
  event.outcome === 'success' &&
  event.result_outcome !== 'duplicate_candidates';

// Did this call leave a durable change behind? A gated create did not.
const isWrite = (event: LoggedEvent): boolean =>
  isCreated(event) ||
  (event.outcome === 'success' &&
    (event.tool === 'update_memory' || event.tool === 'archive_memory'));

function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

// Nearest-rank percentile over an ascending array. Empty input yields 0.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

// Guarded ratio: 0 when the denominator is 0, rounded to two decimals otherwise.
function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { mean: 0, p50: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    mean: Math.round((total / sorted.length) * 100) / 100,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1]!,
  };
}

// Events grouped by session, each list in log order (which is append order, and
// therefore call order — timestamps are only second-granular). Events without a
// session id are left out entirely; the caller counts them separately.
function sessionGroups(events: LoggedEvent[]): Map<string, LoggedEvent[]> {
  const groups = new Map<string, LoggedEvent[]>();
  for (const event of events) {
    if (!event.session_id) continue;
    const list = groups.get(event.session_id);
    if (list) list.push(event);
    else groups.set(event.session_id, [event]);
  }
  return groups;
}

export function computeMetrics(events: LoggedEvent[]): Metrics {
  const callsByTool: Record<string, number> = {};
  const outcomeCounts = { success: 0, error: 0 };
  const errorsByCode: Record<string, number> = {};

  const callsByDay = new Map<string, { total: number; byTool: Record<string, number> }>();
  const createsByDay = new Map<string, number>();
  const searchByDay = new Map<string, number>();
  const latencies = new Map<string, number[]>();

  let first: string | undefined;
  let last: string | undefined;

  for (const event of events) {
    const day = dayOf(event);
    if (first === undefined || day < first) first = day;
    if (last === undefined || day > last) last = day;

    increment(callsByTool, event.tool);
    if (event.outcome === 'success' || event.outcome === 'error') {
      outcomeCounts[event.outcome]++;
    }
    if (event.outcome === 'error') {
      increment(errorsByCode, event.error_code ?? UNKNOWN);
    }

    const dayEntry = callsByDay.get(day) ?? { total: 0, byTool: {} };
    dayEntry.total++;
    increment(dayEntry.byTool, event.tool);
    callsByDay.set(day, dayEntry);

    if (typeof event.latency_ms === 'number') {
      const list = latencies.get(event.tool) ?? [];
      list.push(event.latency_ms);
      latencies.set(event.tool, list);
    }

    if (isCreated(event)) {
      createsByDay.set(day, (createsByDay.get(day) ?? 0) + 1);
    }
    if (event.tool === SEARCH_TOOL) {
      searchByDay.set(day, (searchByDay.get(day) ?? 0) + 1);
    }
  }

  const writes = writeMetrics(events);

  return {
    totalCalls: events.length,
    outcomeCounts,
    callsByTool,
    callsByDay: sortedDays([...callsByDay.entries()]).map(([date, v]) => ({
      date,
      total: v.total,
      byTool: v.byTool,
    })),
    errorsByCode,
    memoriesCreatedByDay: cumulative(createsByDay),
    totalMemoriesCreated: writes.created,
    searchCallsByDay: sortedDays([...searchByDay.entries()]).map(([date, count]) => ({
      date,
      count,
    })),
    latencyByTool: latencyStats(latencies),
    sessions: sessionMetrics(events),
    funnel: funnelMetrics(events),
    writes,
    reuse: reuseMetrics(events),
    segments: segmentMetrics(events),
    projectActivity: projectActivity(events),
    dateRange: first !== undefined && last !== undefined ? { first, last } : null,
  };
}

function sessionMetrics(events: LoggedEvent[]): SessionMetrics {
  const groups = sessionGroups(events);
  const callCounts: number[] = [];
  const searchCounts: number[] = [];
  const firstCallByTool: Record<string, number> = {};
  let withSearch = 0;
  let withWrite = 0;

  for (const group of groups.values()) {
    callCounts.push(group.length);
    const searches = group.filter((e) => e.tool === SEARCH_TOOL).length;
    searchCounts.push(searches);
    if (searches > 0) withSearch++;
    if (group.some(isWrite)) withWrite++;
    increment(firstCallByTool, group[0]!.tool);
  }

  return {
    sessionCount: groups.size,
    callsPerSession: distribution(callCounts),
    searchesPerSession: distribution(searchCounts),
    sessionsWithSearch: ratio(withSearch, groups.size),
    sessionsWithWrite: ratio(withWrite, groups.size),
    firstCallByTool,
    unsessionedCalls: events.filter((e) => !e.session_id).length,
  };
}

function funnelMetrics(events: LoggedEvent[]): FunnelMetrics {
  let searches = 0;
  let zeroResults = 0;
  let resultReports = 0;
  let actionableSearches = 0;
  let actedOnSearches = 0;
  let unpromptedGets = 0;
  const resolveOutcomes: Record<string, number> = {};
  let notFound = 0;
  let projectsCreated = 0;

  for (const event of events) {
    if (event.tool === SEARCH_TOOL) {
      searches++;
      if (typeof event.result_count === 'number') {
        resultReports++;
        if (event.result_count === 0) zeroResults++;
      }
    }
    if (event.tool === 'resolve_project' && event.result_outcome) {
      increment(resolveOutcomes, event.result_outcome);
      if (event.result_outcome === 'not_found') notFound++;
    }
    if (event.tool === 'create_project' && event.result_outcome === 'created') {
      projectsCreated++;
    }
  }

  // The search → get join is per session and forward-looking only: a get counts
  // for a search that preceded it and offered that id.
  for (const group of sessionGroups(events).values()) {
    const gets = group
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.tool === GET_TOOL && event.memory_id);

    group.forEach((event, index) => {
      if (event.tool !== SEARCH_TOOL || !event.result_ids?.length) return;
      actionableSearches++;
      const offered = new Set(event.result_ids);
      if (gets.some((get) => get.index > index && offered.has(get.event.memory_id!))) {
        actedOnSearches++;
      }
    });

    const offeredSoFar = new Set<string>();
    for (const event of group) {
      if (event.tool === SEARCH_TOOL) {
        for (const id of event.result_ids ?? []) offeredSoFar.add(id);
      } else if (event.tool === GET_TOOL && event.memory_id && !offeredSoFar.has(event.memory_id)) {
        unpromptedGets++;
      }
    }
  }

  return {
    searches,
    searchZeroResultRate: ratio(zeroResults, resultReports),
    searchActedOnRate: ratio(actedOnSearches, actionableSearches),
    unpromptedGets,
    resolveOutcomes,
    createAfterNotFoundRate: ratio(projectsCreated, notFound),
  };
}

function writeMetrics(events: LoggedEvent[]): WriteMetrics {
  const memoriesByType: Record<string, number> = {};
  const memoriesByScope: Record<string, number> = {};
  let createAttempts = 0;
  let created = 0;
  let gated = 0;
  let forcedCreates = 0;
  let updated = 0;
  let archived = 0;
  let projectCreateAttempts = 0;
  let projectGated = 0;

  for (const event of events) {
    switch (event.tool) {
      case 'create_memory':
        createAttempts++;
        if (event.forced) forcedCreates++;
        if (event.result_outcome === 'duplicate_candidates') gated++;
        if (isCreated(event)) {
          created++;
          if (event.memory_type) increment(memoriesByType, event.memory_type);
          if (event.scope_kind) increment(memoriesByScope, event.scope_kind);
        }
        break;
      case 'create_project':
        projectCreateAttempts++;
        if (event.result_outcome === 'duplicate_candidates') projectGated++;
        break;
      case 'update_memory':
        if (event.outcome === 'success') updated++;
        break;
      case 'archive_memory':
        if (event.outcome === 'success') archived++;
        break;
    }
  }

  return {
    createAttempts,
    created,
    updated,
    archived,
    dedupeGateRate: ratio(gated, createAttempts),
    projectDedupeGateRate: ratio(projectGated, projectCreateAttempts),
    forcedCreates,
    createToUpdateRatio: ratio(created, updated),
    archiveToCreateRatio: ratio(archived, created),
    memoriesByType,
    memoriesByScope,
  };
}

function reuseMetrics(events: LoggedEvent[]): ReuseMetrics {
  // Creation session per memory id, for memories born inside the log window.
  const bornIn = new Map<string, string | undefined>();
  for (const event of events) {
    if (isCreated(event) && event.memory_id && !bornIn.has(event.memory_id)) {
      bornIn.set(event.memory_id, event.session_id);
    }
  }

  const reads = new Map<string, number>();
  const readLater = new Set<string>();
  const readInOtherSession = new Set<string>();

  for (const event of events) {
    if (event.tool !== GET_TOOL || !event.memory_id || event.outcome !== 'success') continue;
    reads.set(event.memory_id, (reads.get(event.memory_id) ?? 0) + 1);
    if (!bornIn.has(event.memory_id)) continue;
    readLater.add(event.memory_id);
    const birthSession = bornIn.get(event.memory_id);
    // No session id on either side means we cannot claim a *later* session.
    if (birthSession && event.session_id && event.session_id !== birthSession) {
      readInOtherSession.add(event.memory_id);
    }
  }

  const topRetrieved = [...reads.entries()]
    .map(([memory_id, count]) => ({ memory_id, reads: count }))
    .sort((a, b) => b.reads - a.reads || (a.memory_id < b.memory_id ? -1 : 1))
    .slice(0, 10);

  return {
    createdInWindow: bornIn.size,
    retrievedLater: readLater.size,
    retrievedInLaterSession: readInOtherSession.size,
    retrievedInLaterSessionRate: ratio(readInOtherSession.size, bornIn.size),
    topRetrieved,
    retrievedIds: [...reads.keys()].sort(),
  };
}

function segmentMetrics(events: LoggedEvent[]): Segment[] {
  const buckets = new Map<string, LoggedEvent[]>();
  for (const event of events) {
    const key = [
      event.variant ?? UNKNOWN,
      event.policy_version ?? UNKNOWN,
      event.server_version ?? UNKNOWN,
      event.client_name ?? UNKNOWN,
    ].join(' · ');
    const list = buckets.get(key);
    if (list) list.push(event);
    else buckets.set(key, [event]);
  }

  return [...buckets.entries()]
    .map(([key, group]) => {
      const [variant, policyVersion, serverVersion, client] = key.split(' · ') as [
        string,
        string,
        string,
        string,
      ];
      const sessions = sessionMetrics(group);
      const writes = writeMetrics(group);
      return {
        variant,
        policyVersion,
        serverVersion,
        client,
        calls: group.length,
        sessions: sessions.sessionCount,
        searchActivationRate: sessions.sessionsWithSearch,
        writeActivationRate: sessions.sessionsWithWrite,
        dedupeGateRate: writes.dedupeGateRate,
        searchZeroResultRate: funnelMetrics(group).searchZeroResultRate,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

function projectActivity(events: LoggedEvent[]): ProjectActivity[] {
  const byProject = new Map<string, ProjectActivity>();
  for (const event of events) {
    for (const id of event.project_ids ?? []) {
      const entry = byProject.get(id) ?? { project_id: id, calls: 0, searches: 0, writes: 0 };
      entry.calls++;
      if (event.tool === SEARCH_TOOL) entry.searches++;
      if (isWrite(event)) entry.writes++;
      byProject.set(id, entry);
    }
  }
  return [...byProject.values()].sort(
    (a, b) => b.calls - a.calls || (a.project_id < b.project_id ? -1 : 1),
  );
}

function sortedDays<T>(entries: [string, T][]): [string, T][] {
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function cumulative(createsByDay: Map<string, number>): CumulativeDay[] {
  let running = 0;
  return sortedDays([...createsByDay.entries()]).map(([date, created]) => {
    running += created;
    return { date, created, cumulative: running };
  });
}

function latencyStats(latencies: Map<string, number[]>): Record<string, LatencyStats> {
  const out: Record<string, LatencyStats> = {};
  for (const [tool, values] of latencies) {
    const sorted = [...values].sort((a, b) => a - b);
    out[tool] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p99: percentile(sorted, 99),
    };
  }
  return out;
}
