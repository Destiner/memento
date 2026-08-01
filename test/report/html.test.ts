import { describe, expect, it } from 'vitest';

import { renderReport } from '../../src/report/html.js';
import { computeMetrics } from '../../src/report/metrics.js';
import type { StoreView } from '../../src/report/store-view.js';
import type { LoggedEvent } from '../../src/logging/events.js';

const SAMPLE: LoggedEvent[] = [
  {
    event_id: 'evt_a',
    timestamp: '2026-07-01T09:00:00Z',
    session_id: 'ses_A',
    tool: 'create_memory',
    outcome: 'success',
    latency_ms: 10,
    result_outcome: 'created',
    memory_id: 'mem_ONE',
    memory_type: 'decision_history',
    scope_kind: 'projects',
    project_count: 1,
    project_ids: ['prj_ONE'],
    server_version: '0.3.2',
    policy_version: '2.1.0',
    variant: 'shipped-v2',
    client_name: 'claude-code',
    log_schema_version: 2,
  },
  {
    event_id: 'evt_b',
    timestamp: '2026-07-01T09:05:00Z',
    session_id: 'ses_A',
    tool: 'search_memories',
    outcome: 'success',
    latency_ms: 40,
    result_count: 0,
    result_ids: [],
    scope_kind: 'projects',
    project_count: 1,
    project_ids: ['prj_ONE'],
    server_version: '0.3.2',
    policy_version: '2.1.0',
    variant: 'shipped-v2',
    client_name: 'claude-code',
    log_schema_version: 2,
  },
  {
    event_id: 'evt_c',
    timestamp: '2026-07-01T09:06:00Z',
    session_id: 'ses_A',
    tool: 'get_memory',
    outcome: 'success',
    latency_ms: 5,
    memory_id: 'mem_ONE',
    server_version: '0.3.2',
    policy_version: '2.1.0',
    variant: 'shipped-v2',
    client_name: 'claude-code',
    log_schema_version: 2,
  },
];

const STORE: StoreView = {
  projectNames: { prj_ONE: 'Alpha' },
  memoryTitles: { mem_ONE: 'Retry budget was never raised' },
  totalMemories: 1,
  activeMemories: 1,
  archivedMemories: 0,
  archivedRate: 0,
  neverRetrieved: 0,
  neverRetrievedRate: 0,
  staleMemories: [],
  unreadableFiles: [],
};

const EMPTY_STORE: StoreView = {
  projectNames: {},
  memoryTitles: {},
  totalMemories: 0,
  activeMemories: 0,
  archivedMemories: 0,
  archivedRate: 0,
  neverRetrieved: 0,
  neverRetrievedRate: 0,
  staleMemories: [],
  unreadableFiles: [],
};

const OPTIONS = { generatedAt: '2026-07-04T12:00:00Z', logsDir: '/tmp/logs' };

describe('renderReport', () => {
  it('produces a self-contained HTML document with no external assets', () => {
    const html = renderReport(computeMetrics(SAMPLE), STORE, OPTIONS);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Memento — usage report</title>');
    // Self-contained: no remote scripts, stylesheets, or fonts.
    expect(html).not.toMatch(/<script|src=|<link/i);
  });

  it('surfaces the headline metrics and generation context', () => {
    const html = renderReport(computeMetrics(SAMPLE), STORE, OPTIONS);
    expect(html).toContain('Total tool calls');
    expect(html).toContain('>3</div>'); // total calls tile
    expect(html).toContain('100%'); // 1 of 1 counted searches returned nothing
    expect(html).toContain('2026-07-04T12:00:00Z');
    expect(html).toContain('/tmp/logs');
    expect(html).toContain('create_memory');
  });

  it('renders names from the store rather than the log’s opaque ids', () => {
    const html = renderReport(computeMetrics(SAMPLE), STORE, OPTIONS);
    expect(html).toContain('Alpha');
    expect(html).toContain('Retry budget was never raised');
    expect(html).not.toContain('prj_ONE');
    expect(html).not.toContain('mem_ONE');
  });

  it('falls back to the id when the store has no name for it', () => {
    const html = renderReport(computeMetrics(SAMPLE), EMPTY_STORE, OPTIONS);
    expect(html).toContain('prj_ONE');
    expect(html).toContain('mem_ONE');
  });

  it('shows the segmentation axes so arms are not compared blindly', () => {
    const html = renderReport(computeMetrics(SAMPLE), STORE, OPTIONS);
    expect(html).toContain('shipped-v2');
    expect(html).toContain('2.1.0');
    expect(html).toContain('claude-code');
    expect(html).toContain('Only compare rows that differ on one axis');
  });

  it('escapes values that could contain HTML metacharacters', () => {
    const html = renderReport(computeMetrics([]), EMPTY_STORE, {
      ...OPTIONS,
      logsDir: '/tmp/<x>&"y"',
    });
    expect(html).toContain('/tmp/&lt;x&gt;&amp;&quot;y&quot;');
    expect(html).not.toContain('/tmp/<x>&"y"');
  });

  it('escapes store-supplied titles, which are user-authored text', () => {
    const html = renderReport(
      computeMetrics(SAMPLE),
      {
        ...STORE,
        memoryTitles: { mem_ONE: '<img src=x onerror=alert(1)>' },
      },
      OPTIONS,
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('renders a friendly empty state when there are no events', () => {
    const html = renderReport(computeMetrics([]), EMPTY_STORE, OPTIONS);
    expect(html).toContain('no events yet');
    expect(html).toContain('No data yet.');
  });
});
