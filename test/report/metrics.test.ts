import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { LoggedEvent } from '../../src/logging/events.js';
import { loadEvents } from '../../src/report/load.js';
import { computeMetrics, type Metrics } from '../../src/report/metrics.js';

const LOGS_DIR = fileURLToPath(new URL('../fixtures/logs', import.meta.url));

describe('computeMetrics (sample event logs)', () => {
  let events: LoggedEvent[];
  let metrics: Metrics;

  beforeAll(async () => {
    events = await loadEvents(LOGS_DIR);
    metrics = computeMetrics(events);
  });

  it('counts total calls, outcomes, and per-tool totals', () => {
    expect(metrics.totalCalls).toBe(11);
    expect(metrics.outcomeCounts).toEqual({ success: 10, error: 1 });
    expect(metrics.callsByTool).toEqual({
      create_memory: 4,
      search_memories: 3,
      get_memory: 3,
      update_memory: 1,
    });
  });

  it('breaks calls down by day and tool', () => {
    expect(metrics.callsByDay).toEqual([
      {
        date: '2026-07-01',
        total: 6,
        byTool: { create_memory: 2, search_memories: 2, get_memory: 2 },
      },
      {
        date: '2026-07-02',
        total: 5,
        byTool: {
          create_memory: 2,
          search_memories: 1,
          get_memory: 1,
          update_memory: 1,
        },
      },
    ]);
  });

  // Four create_memory calls, three memories: one call was stopped by the dedupe
  // gate, which is a successful call that wrote nothing.
  it('accumulates memories created over time and by type/scope', () => {
    expect(metrics.totalMemoriesCreated).toBe(3);
    expect(metrics.memoriesCreatedByDay).toEqual([
      { date: '2026-07-01', created: 2, cumulative: 2 },
      { date: '2026-07-02', created: 1, cumulative: 3 },
    ]);
    expect(metrics.memoriesByType).toEqual({
      debugging_pattern: 1,
      preference: 1,
      decision_history: 1,
    });
    expect(metrics.memoriesByScope).toEqual({ projects: 2, global: 1 });
  });

  it('derives search health and cross-tool ratios', () => {
    expect(metrics.searchCallsByDay).toEqual([
      { date: '2026-07-01', count: 2 },
      { date: '2026-07-02', count: 1 },
    ]);
    // 1 of 3 searches that reported a count returned nothing.
    expect(metrics.searchZeroResultRate).toBeCloseTo(0.33, 2);
    // reads (3) / searches (3)
    expect(metrics.searchToReadConversion).toBe(1);
    // reads (3) / (create calls 4 + updates 1)
    expect(metrics.readToWriteRatio).toBe(0.6);
  });

  it('computes latency percentiles per tool', () => {
    expect(metrics.latencyByTool.create_memory).toEqual({ count: 4, p50: 12, p90: 20, p99: 20 });
    expect(metrics.latencyByTool.search_memories).toEqual({ count: 3, p50: 40, p90: 50, p99: 50 });
    expect(metrics.latencyByTool.get_memory).toEqual({ count: 3, p50: 5, p90: 6, p99: 6 });
    expect(metrics.latencyByTool.update_memory).toEqual({ count: 1, p50: 15, p90: 15, p99: 15 });
  });

  it('reports the date range spanned by the logs', () => {
    expect(metrics.dateRange).toEqual({ first: '2026-07-01', last: '2026-07-02' });
  });

  it('degrades gracefully on an empty event stream', () => {
    const empty = computeMetrics([]);
    expect(empty.totalCalls).toBe(0);
    expect(empty.searchZeroResultRate).toBe(0);
    expect(empty.searchToReadConversion).toBe(0);
    expect(empty.readToWriteRatio).toBe(0);
    expect(empty.dateRange).toBeNull();
  });
});
