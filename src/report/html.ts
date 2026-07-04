// Render the §13 metrics into a single self-contained HTML page.
//
// No external assets, scripts, or fonts: the report is an operator tool served
// locally, so everything (styles, simple bar charts as divs) is inlined. This is
// a view over `Metrics` only — all aggregation lives in metrics.ts.

import type { Metrics } from './metrics.js';

export interface RenderOptions {
  generatedAt: string;
  logsDir: string;
}

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (value: number): string => `${Math.round(value * 100)}%`;

// A horizontal bar row scaled against the largest value in its group.
function bar(label: string, value: number, max: number, suffix = ''): string {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="bar-row"><span class="bar-label">${escape(label)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
    <span class="bar-value">${value}${suffix}</span></div>`;
}

function barGroup(entries: [string, number][]): string {
  if (entries.length === 0) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...entries.map(([, v]) => v));
  return entries.map(([label, value]) => bar(label, value, max)).join('\n');
}

function statTile(label: string, value: string): string {
  return `<div class="tile"><div class="tile-value">${escape(value)}</div>
    <div class="tile-label">${escape(label)}</div></div>`;
}

function latencyTable(metrics: Metrics): string {
  const rows = Object.entries(metrics.latencyByTool)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([tool, s]) =>
        `<tr><td>${escape(tool)}</td><td>${s.count}</td><td>${s.p50}</td><td>${s.p90}</td><td>${s.p99}</td></tr>`,
    )
    .join('\n');
  if (!rows) return '<p class="empty">No data yet.</p>';
  return `<table><thead><tr><th>tool</th><th>calls</th><th>p50 ms</th><th>p90 ms</th><th>p99 ms</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function callsByDayTable(metrics: Metrics): string {
  const tools = Object.keys(metrics.callsByTool).sort();
  if (tools.length === 0) return '<p class="empty">No data yet.</p>';
  const head = tools.map((t) => `<th>${escape(t)}</th>`).join('');
  const rows = metrics.callsByDay
    .map((day) => {
      const cells = tools.map((t) => `<td>${day.byTool[t] ?? 0}</td>`).join('');
      return `<tr><td>${escape(day.date)}</td>${cells}<td><strong>${day.total}</strong></td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>date</th>${head}<th>total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function memoriesOverTime(metrics: Metrics): string {
  if (metrics.memoriesCreatedByDay.length === 0) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...metrics.memoriesCreatedByDay.map((d) => d.cumulative));
  return metrics.memoriesCreatedByDay
    .map((d) => bar(`${d.date} (+${d.created})`, d.cumulative, max))
    .join('\n');
}

export function renderReport(metrics: Metrics, options: RenderOptions): string {
  const range = metrics.dateRange
    ? `${metrics.dateRange.first} → ${metrics.dateRange.last}`
    : 'no events yet';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memento — usage report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem;
    max-width: 960px; margin-inline: auto; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #888; margin: 0 0 2rem; font-size: 13px; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; color: #888;
    border-bottom: 1px solid currentColor; padding-bottom: .35rem; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
  .tile { border: 1px solid #8884; border-radius: 8px; padding: 1rem; }
  .tile-value { font-size: 1.8rem; font-weight: 600; }
  .tile-label { color: #888; font-size: 13px; }
  .bar-row { display: grid; grid-template-columns: 200px 1fr 60px; align-items: center;
    gap: .5rem; margin: .25rem 0; }
  .bar-label { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #8882; border-radius: 4px; height: 14px; }
  .bar-fill { display: block; height: 100%; border-radius: 4px; background: #4a90d9; }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #8883; }
  td { font-variant-numeric: tabular-nums; }
  .empty { color: #888; font-style: italic; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  @media (max-width: 640px) { .cols { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>Memento usage report</h1>
<p class="meta">Generated ${escape(options.generatedAt)} · logs: ${escape(options.logsDir)} · range: ${escape(range)}</p>

<section>
  <h2>Overview</h2>
  <div class="tiles">
    ${statTile('Total tool calls', String(metrics.totalCalls))}
    ${statTile('Errors', String(metrics.outcomeCounts.error))}
    ${statTile('Memories created', String(metrics.totalMemoriesCreated))}
    ${statTile('Search zero-result rate', pct(metrics.searchZeroResultRate))}
    ${statTile('Search → read', String(metrics.searchToReadConversion))}
    ${statTile('Read : write', String(metrics.readToWriteRatio))}
  </div>
</section>

<section>
  <h2>Tool calls by tool</h2>
  ${barGroup(Object.entries(metrics.callsByTool).sort(([a], [b]) => (a < b ? -1 : 1)))}
</section>

<section>
  <h2>Tool calls by day</h2>
  ${callsByDayTable(metrics)}
</section>

<section>
  <h2>Memories created (cumulative)</h2>
  ${memoriesOverTime(metrics)}
</section>

<section class="cols">
  <div>
    <h2>Memories by type</h2>
    ${barGroup(Object.entries(metrics.memoriesByType).sort(([, a], [, b]) => b - a))}
  </div>
  <div>
    <h2>Memories by scope</h2>
    ${barGroup(Object.entries(metrics.memoriesByScope).sort(([, a], [, b]) => b - a))}
  </div>
</section>

<section>
  <h2>Search calls by day</h2>
  ${barGroup(metrics.searchCallsByDay.map((d) => [d.date, d.count] as [string, number]))}
</section>

<section>
  <h2>Latency percentiles by tool</h2>
  ${latencyTable(metrics)}
</section>

<p class="meta">More tool calls do not automatically mean better outcomes; higher memory
count can indicate usefulness or clutter. Usefulness needs explicit evaluation, not raw usage.</p>
</body>
</html>`;
}
