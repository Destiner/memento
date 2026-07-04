import { describe, expect, it } from 'vitest';

import { renderReport } from '../../src/report/html.js';
import { computeMetrics } from '../../src/report/metrics.js';
import type { LoggedEvent } from '../../src/logging/events.js';

const SAMPLE: LoggedEvent[] = [
  {
    event_id: 'evt_a',
    timestamp: '2026-07-01T09:00:00Z',
    tool: 'create_memory',
    outcome: 'success',
    latency_ms: 10,
    memory_type: 'decision',
    memory_scope: 'project',
    server_version: '0.1.0',
  },
  {
    event_id: 'evt_b',
    timestamp: '2026-07-01T09:05:00Z',
    tool: 'search_memory',
    outcome: 'success',
    latency_ms: 40,
    result_count: 0,
    server_version: '0.1.0',
  },
  {
    event_id: 'evt_c',
    timestamp: '2026-07-01T09:06:00Z',
    tool: 'read_memory',
    outcome: 'success',
    latency_ms: 5,
    server_version: '0.1.0',
  },
];

const OPTIONS = { generatedAt: '2026-07-04T12:00:00Z', logsDir: '/tmp/logs' };

describe('renderReport', () => {
  it('produces a self-contained HTML document with no external assets', () => {
    const html = renderReport(computeMetrics(SAMPLE), OPTIONS);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Memento — usage report</title>');
    // Self-contained: no remote scripts, stylesheets, or fonts.
    expect(html).not.toMatch(/<script|src=|<link/i);
  });

  it('surfaces the headline metrics and generation context', () => {
    const html = renderReport(computeMetrics(SAMPLE), OPTIONS);
    expect(html).toContain('Total tool calls');
    expect(html).toContain('>3</div>'); // total calls tile
    expect(html).toContain('100%'); // 1 of 1 counted searches returned nothing
    expect(html).toContain('2026-07-04T12:00:00Z');
    expect(html).toContain('/tmp/logs');
    expect(html).toContain('create_memory');
  });

  it('escapes values that could contain HTML metacharacters', () => {
    const html = renderReport(computeMetrics([]), { ...OPTIONS, logsDir: '/tmp/<x>&"y"' });
    expect(html).toContain('/tmp/&lt;x&gt;&amp;&quot;y&quot;');
    expect(html).not.toContain('/tmp/<x>&"y"');
  });

  it('renders a friendly empty state when there are no events', () => {
    const html = renderReport(computeMetrics([]), OPTIONS);
    expect(html).toContain('no events yet');
    expect(html).toContain('No data yet.');
  });
});
