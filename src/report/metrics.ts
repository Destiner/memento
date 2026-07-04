// Aggregate raw tool-call events into the §13 dashboard metrics.
//
// Pure and log-only: every number here is derived solely from the JSONL event
// stream — nothing reads the memory store — so the report is a faithful view of
// instrumented usage and stays trivially testable against sample logs. Metrics
// answer "are the tools used, are searches returning anything, are writes
// accumulating manageably?" and deliberately make no claim about task quality.

import type { LoggedEvent } from '../logging/events.js';

export interface LatencyStats {
  count: number;
  p50: number;
  p90: number;
  p99: number;
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

export interface Metrics {
  totalCalls: number;
  outcomeCounts: { success: number; error: number };
  callsByTool: Record<string, number>;
  callsByDay: DayToolCount[];
  memoriesCreatedByDay: CumulativeDay[];
  totalMemoriesCreated: number;
  memoriesByType: Record<string, number>;
  memoriesByScope: Record<string, number>;
  searchCallsByDay: DayCount[];
  // Share of successful searches that returned nothing (0..1); 0 when no search
  // reported a result_count.
  searchZeroResultRate: number;
  // Coarse reads ÷ searches ratio (§13). No session correlation exists in the
  // event stream, so this is a usage proxy, not a per-query funnel.
  searchToReadConversion: number;
  // Reads ÷ (creates + updates): are agents consuming memory faster than they
  // write it?
  readToWriteRatio: number;
  latencyByTool: Record<string, LatencyStats>;
  dateRange: { first: string; last: string } | null;
}

const dayOf = (event: LoggedEvent): string => event.timestamp.slice(0, 10);

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

export function computeMetrics(events: LoggedEvent[]): Metrics {
  const callsByTool: Record<string, number> = {};
  const outcomeCounts = { success: 0, error: 0 };
  const memoriesByType: Record<string, number> = {};
  const memoriesByScope: Record<string, number> = {};

  const callsByDay = new Map<string, { total: number; byTool: Record<string, number> }>();
  const createsByDay = new Map<string, number>();
  const searchByDay = new Map<string, number>();
  const latencies = new Map<string, number[]>();

  let searchResultReports = 0;
  let searchZeroResults = 0;
  let totalMemoriesCreated = 0;
  const toolTotals = { read: 0, search: 0, create: 0, update: 0 };

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

    const dayEntry = callsByDay.get(day) ?? { total: 0, byTool: {} };
    dayEntry.total++;
    increment(dayEntry.byTool, event.tool);
    callsByDay.set(day, dayEntry);

    if (typeof event.latency_ms === 'number') {
      const list = latencies.get(event.tool) ?? [];
      list.push(event.latency_ms);
      latencies.set(event.tool, list);
    }

    switch (event.tool) {
      case 'read_memory':
        toolTotals.read++;
        break;
      case 'update_memory':
        toolTotals.update++;
        break;
      case 'create_memory':
        toolTotals.create++;
        if (event.outcome === 'success') {
          totalMemoriesCreated++;
          createsByDay.set(day, (createsByDay.get(day) ?? 0) + 1);
          if (event.memory_type) increment(memoriesByType, event.memory_type);
          if (event.memory_scope) increment(memoriesByScope, event.memory_scope);
        }
        break;
      case 'search_memory':
        toolTotals.search++;
        searchByDay.set(day, (searchByDay.get(day) ?? 0) + 1);
        if (typeof event.result_count === 'number') {
          searchResultReports++;
          if (event.result_count === 0) searchZeroResults++;
        }
        break;
    }
  }

  return {
    totalCalls: events.length,
    outcomeCounts,
    callsByTool,
    callsByDay: sortedDays([...callsByDay.entries()]).map(([date, v]) => ({
      date,
      total: v.total,
      byTool: v.byTool,
    })),
    memoriesCreatedByDay: cumulative(createsByDay),
    totalMemoriesCreated,
    memoriesByType,
    memoriesByScope,
    searchCallsByDay: sortedDays([...searchByDay.entries()]).map(([date, count]) => ({
      date,
      count,
    })),
    searchZeroResultRate: ratio(searchZeroResults, searchResultReports),
    searchToReadConversion: ratio(toolTotals.read, toolTotals.search),
    readToWriteRatio: ratio(toolTotals.read, toolTotals.create + toolTotals.update),
    latencyByTool: latencyStats(latencies),
    dateRange: first !== undefined && last !== undefined ? { first, last } : null,
  };
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
