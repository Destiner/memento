import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { LoggedEvent } from '../../src/logging/events.js';
import { loadEvents } from '../../src/report/load.js';
import { computeMetrics, type Metrics } from '../../src/report/metrics.js';

const LOGS_DIR = fileURLToPath(new URL('../fixtures/logs', import.meta.url));

// The fixture is three sessions across two days: ses_A and ses_C run the
// shipped-v2 variant under Claude Code, and ses_B runs plain under Codex.
describe('computeMetrics (sample event logs)', () => {
  let events: LoggedEvent[];
  let metrics: Metrics;

  beforeAll(async () => {
    events = await loadEvents(LOGS_DIR);
    metrics = computeMetrics(events);
  });

  it('counts total calls, outcomes, and per-tool totals', () => {
    expect(metrics.totalCalls).toBe(16);
    expect(metrics.outcomeCounts).toEqual({ success: 15, error: 1 });
    expect(metrics.callsByTool).toEqual({
      resolve_project: 2,
      create_project: 1,
      search_memories: 3,
      get_memory: 4,
      create_memory: 4,
      update_memory: 1,
      archive_memory: 1,
    });
    expect(metrics.errorsByCode).toEqual({ not_found: 1 });
  });

  it('breaks calls down by day and tool', () => {
    expect(metrics.callsByDay).toEqual([
      {
        date: '2026-07-01',
        total: 8,
        byTool: { resolve_project: 1, search_memories: 2, get_memory: 3, create_memory: 2 },
      },
      {
        date: '2026-07-02',
        total: 8,
        byTool: {
          get_memory: 1,
          search_memories: 1,
          create_memory: 2,
          update_memory: 1,
          archive_memory: 1,
          resolve_project: 1,
          create_project: 1,
        },
      },
    ]);
  });

  it('groups calls by session', () => {
    expect(metrics.sessions.sessionCount).toBe(3);
    expect(metrics.sessions.callsPerSession).toEqual({ mean: 5.33, p50: 6, p90: 8, max: 8 });
    expect(metrics.sessions.searchesPerSession).toEqual({ mean: 1, p50: 1, p90: 2, max: 2 });
    // ses_A and ses_C searched; ses_B went straight to a write.
    expect(metrics.sessions.sessionsWithSearch).toBe(0.67);
    expect(metrics.sessions.sessionsWithWrite).toBe(1);
    expect(metrics.sessions.firstCallByTool).toEqual({
      resolve_project: 1,
      create_memory: 1,
      get_memory: 1,
    });
  });

  it('joins searches to the gets that opened their own results', () => {
    // ses_A's first search offered mem_TWO and a later get opened it; ses_C's
    // search offered mem_FOUR but the only get of it came *before* the search.
    expect(metrics.funnel.searchActedOnRate).toBe(0.5);
    // A get nobody's search offered: ses_B's mem_NINE, and ses_C's opening get.
    expect(metrics.funnel.unpromptedGets).toBe(2);
    expect(metrics.funnel.searches).toBe(3);
    expect(metrics.funnel.searchZeroResultRate).toBe(0.33);
    expect(metrics.funnel.resolveOutcomes).toEqual({ exact_match: 1, not_found: 1 });
    expect(metrics.funnel.createAfterNotFoundRate).toBe(1);
  });

  it('separates writes that landed from create attempts the gate stopped', () => {
    expect(metrics.writes).toMatchObject({
      createAttempts: 4,
      created: 3,
      updated: 1,
      archived: 1,
      dedupeGateRate: 0.25,
      projectDedupeGateRate: 0,
      forcedCreates: 1,
      createToUpdateRatio: 3,
      archiveToCreateRatio: 0.33,
    });
    expect(metrics.totalMemoriesCreated).toBe(3);
    expect(metrics.memoriesCreatedByDay).toEqual([
      { date: '2026-07-01', created: 2, cumulative: 2 },
      { date: '2026-07-02', created: 1, cumulative: 3 },
    ]);
    expect(metrics.writes.memoriesByType).toEqual({
      debugging_pattern: 1,
      preference: 1,
      decision_history: 1,
    });
    expect(metrics.writes.memoriesByScope).toEqual({ projects: 2, global: 1 });
  });

  it('counts a memory as reused only when a *later* session reads it', () => {
    // mem_FOUR is created in ses_A and read again in ses_C the next day.
    expect(metrics.reuse).toMatchObject({
      createdInWindow: 3,
      retrievedLater: 1,
      retrievedInLaterSession: 1,
      retrievedInLaterSessionRate: 0.33,
    });
    expect(metrics.reuse.retrievedIds).toEqual(['mem_FOUR', 'mem_NINE', 'mem_TWO']);
    expect(metrics.reuse.topRetrieved).toEqual([
      { memory_id: 'mem_FOUR', reads: 1 },
      { memory_id: 'mem_NINE', reads: 1 },
      { memory_id: 'mem_TWO', reads: 1 },
    ]);
  });

  it('splits headline numbers by variant, policy, server, and client', () => {
    expect(metrics.segments).toEqual([
      {
        variant: 'shipped-v2',
        policyVersion: '2.1.0',
        serverVersion: '0.3.2',
        client: 'claude-code',
        calls: 14,
        sessions: 2,
        searchActivationRate: 1,
        writeActivationRate: 1,
        dedupeGateRate: 0.33,
        searchZeroResultRate: 0.33,
      },
      {
        variant: 'plain',
        policyVersion: '2.1.0',
        serverVersion: '0.3.2',
        client: 'codex',
        calls: 2,
        sessions: 1,
        searchActivationRate: 0,
        writeActivationRate: 1,
        dedupeGateRate: 0,
        searchZeroResultRate: 0,
      },
    ]);
  });

  it('attributes activity to the projects a call was scoped to', () => {
    expect(metrics.projectActivity).toEqual([
      { project_id: 'prj_ONE', calls: 9, searches: 3, writes: 2 },
      { project_id: 'prj_TWO', calls: 3, searches: 1, writes: 1 },
    ]);
  });

  it('derives search volume and latency percentiles per tool', () => {
    expect(metrics.searchCallsByDay).toEqual([
      { date: '2026-07-01', count: 2 },
      { date: '2026-07-02', count: 1 },
    ]);
    expect(metrics.latencyByTool.create_memory).toEqual({ count: 4, p50: 12, p90: 20, p99: 20 });
    expect(metrics.latencyByTool.search_memories).toEqual({ count: 3, p50: 40, p90: 50, p99: 50 });
    expect(metrics.latencyByTool.get_memory).toEqual({ count: 4, p50: 4, p90: 6, p99: 6 });
    expect(metrics.latencyByTool.update_memory).toEqual({ count: 1, p50: 15, p90: 15, p99: 15 });
  });

  it('reports the date range spanned by the logs', () => {
    expect(metrics.dateRange).toEqual({ first: '2026-07-01', last: '2026-07-02' });
  });

  it('degrades gracefully on an empty event stream', () => {
    const empty = computeMetrics([]);
    expect(empty.totalCalls).toBe(0);
    expect(empty.sessions.sessionCount).toBe(0);
    expect(empty.sessions.callsPerSession).toEqual({ mean: 0, p50: 0, p90: 0, max: 0 });
    expect(empty.funnel.searchZeroResultRate).toBe(0);
    expect(empty.funnel.searchActedOnRate).toBe(0);
    expect(empty.writes.dedupeGateRate).toBe(0);
    expect(empty.reuse.retrievedInLaterSessionRate).toBe(0);
    expect(empty.segments).toEqual([]);
    expect(empty.projectActivity).toEqual([]);
    expect(empty.dateRange).toBeNull();
  });
});
