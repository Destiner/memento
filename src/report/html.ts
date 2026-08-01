// Render the §8 metrics into a single self-contained HTML page.
//
// No external assets, scripts, or fonts: the report is an operator tool served
// locally, so everything (styles, simple bar charts as divs) is inlined. This is
// a view only — log aggregation lives in metrics.ts, and everything that needs
// the memory store comes in as a StoreView, already loaded.

import type { Metrics } from './metrics.js';
import { STALE_AFTER_DAYS, type StoreView } from './store-view.js';

export interface RenderOptions {
  generatedAt: string;
  logsDir: string;
}

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (value: number): string => `${Math.round(value * 100)}%`;

const EMPTY = '<p class="empty">No data yet.</p>';

// A horizontal bar row scaled against the largest value in its group.
function bar(label: string, value: number, max: number, suffix = ''): string {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="bar-row"><span class="bar-label">${escape(label)}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
    <span class="bar-value">${value}${suffix}</span></div>`;
}

function barGroup(entries: [string, number][]): string {
  if (entries.length === 0) return EMPTY;
  const max = Math.max(...entries.map(([, v]) => v));
  return entries.map(([label, value]) => bar(label, value, max)).join('\n');
}

function statTile(label: string, value: string, note?: string): string {
  const hint = note ? `<div class="tile-note">${escape(note)}</div>` : '';
  return `<div class="tile"><div class="tile-value">${escape(value)}</div>
    <div class="tile-label">${escape(label)}</div>${hint}</div>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return EMPTY;
  const head = headers.map((h) => `<th>${escape(h)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function latencyTable(metrics: Metrics): string {
  const rows = Object.entries(metrics.latencyByTool)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tool, s]) => [
      escape(tool),
      String(s.count),
      String(s.p50),
      String(s.p90),
      String(s.p99),
    ]);
  return table(['tool', 'calls', 'p50 ms', 'p90 ms', 'p99 ms'], rows);
}

function callsByDayTable(metrics: Metrics): string {
  const tools = Object.keys(metrics.callsByTool).sort();
  if (tools.length === 0) return EMPTY;
  const rows = metrics.callsByDay.map((day) => [
    escape(day.date),
    ...tools.map((t) => String(day.byTool[t] ?? 0)),
    `<strong>${day.total}</strong>`,
  ]);
  return table(['date', ...tools, 'total'], rows);
}

function memoriesOverTime(metrics: Metrics): string {
  if (metrics.memoriesCreatedByDay.length === 0) return EMPTY;
  const max = Math.max(...metrics.memoriesCreatedByDay.map((d) => d.cumulative));
  return metrics.memoriesCreatedByDay
    .map((d) => bar(`${d.date} (+${d.created})`, d.cumulative, max))
    .join('\n');
}

function segmentTable(metrics: Metrics): string {
  const rows = metrics.segments.map((s) => [
    escape(s.variant),
    escape(s.policyVersion),
    escape(s.serverVersion),
    escape(s.client),
    String(s.calls),
    String(s.sessions),
    pct(s.searchActivationRate),
    pct(s.writeActivationRate),
    pct(s.dedupeGateRate),
    pct(s.searchZeroResultRate),
  ]);
  return table(
    [
      'variant',
      'policy',
      'server',
      'client',
      'calls',
      'sessions',
      'searched',
      'wrote',
      'gated',
      'empty',
    ],
    rows,
  );
}

function projectTable(metrics: Metrics, store: StoreView): string {
  const rows = metrics.projectActivity.slice(0, 20).map((p) => [
    // A dangling id means the registry entry was deleted by hand; show the id
    // rather than hiding the row, since the events are still real.
    escape(store.projectNames[p.project_id] ?? p.project_id),
    String(p.calls),
    String(p.searches),
    String(p.writes),
  ]);
  return table(['project', 'calls', 'searches', 'writes'], rows);
}

function topRetrievedTable(metrics: Metrics, store: StoreView): string {
  const rows = metrics.reuse.topRetrieved.map((m) => [
    escape(store.memoryTitles[m.memory_id] ?? m.memory_id),
    String(m.reads),
  ]);
  return table(['memory', 'reads'], rows);
}

function staleTable(store: StoreView): string {
  const rows = store.staleMemories
    .slice(0, 20)
    .map((m) => [escape(m.title), escape(m.type), escape(m.updated_at.slice(0, 10))]);
  if (rows.length === 0) {
    return `<p class="empty">Nothing untouched for ${STALE_AFTER_DAYS} days.</p>`;
  }
  return table(['memory', 'type', 'last updated'], rows);
}

export function renderReport(metrics: Metrics, store: StoreView, options: RenderOptions): string {
  const range = metrics.dateRange
    ? `${metrics.dateRange.first} → ${metrics.dateRange.last}`
    : 'no events yet';
  const { sessions, funnel, writes, reuse } = metrics;
  const unsessioned =
    sessions.unsessionedCalls > 0
      ? `<p class="note">${sessions.unsessionedCalls} call(s) predate session ids and are
         excluded from this section.</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memento — usage report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem;
    max-width: 1040px; margin-inline: auto; }
  h1 { margin: 0 0 .25rem; }
  .meta { color: #888; margin: 0 0 2rem; font-size: 13px; }
  .note { color: #888; font-size: 13px; margin: .5rem 0 0; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; color: #888;
    border-bottom: 1px solid currentColor; padding-bottom: .35rem; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
  .tile { border: 1px solid #8884; border-radius: 8px; padding: 1rem; }
  .tile-value { font-size: 1.8rem; font-weight: 600; }
  .tile-label { color: #888; font-size: 13px; }
  .tile-note { color: #888; font-size: 11px; margin-top: .35rem; }
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
    ${statTile('Sessions', String(sessions.sessionCount))}
    ${statTile('Errors', String(metrics.outcomeCounts.error))}
    ${statTile('Memories created', String(writes.created))}
    ${statTile('Active memories', String(store.activeMemories))}
    ${statTile('Reused later', pct(reuse.retrievedInLaterSessionRate), 'read in a later session')}
  </div>
</section>

<section>
  <h2>Activation</h2>
  <div class="tiles">
    ${statTile('Sessions that searched', pct(sessions.sessionsWithSearch))}
    ${statTile('Sessions that wrote', pct(sessions.sessionsWithWrite))}
    ${statTile('Searches / session', String(sessions.searchesPerSession.mean), 'mean; guardrail, not a goal')}
    ${statTile('Calls / session', String(sessions.callsPerSession.mean), 'mean')}
  </div>
  ${unsessioned}
  <h2 style="margin-top:1.5rem">First call of a session</h2>
  ${barGroup(Object.entries(sessions.firstCallByTool).sort(([, a], [, b]) => b - a))}
</section>

<section>
  <h2>Search funnel</h2>
  <div class="tiles">
    ${statTile('Searches', String(funnel.searches))}
    ${statTile('Zero-result rate', pct(funnel.searchZeroResultRate))}
    ${statTile('Acted on', pct(funnel.searchActedOnRate), 'a result was opened in-session')}
    ${statTile('Unprompted gets', String(funnel.unpromptedGets), 'no search offered that id')}
  </div>
</section>

<section>
  <h2>Writes</h2>
  <div class="tiles">
    ${statTile('Create attempts', String(writes.createAttempts))}
    ${statTile('Dedupe-gated', pct(writes.dedupeGateRate), 'candidates returned, nothing written')}
    ${statTile('Forced creates', String(writes.forcedCreates))}
    ${statTile('Create : update', String(writes.createToUpdateRatio))}
    ${statTile('Archive : create', String(writes.archiveToCreateRatio))}
    ${statTile('Project gate rate', pct(writes.projectDedupeGateRate))}
  </div>
</section>

<section>
  <h2>Project resolution</h2>
  ${barGroup(Object.entries(funnel.resolveOutcomes).sort(([, a], [, b]) => b - a))}
  <p class="note">Create-after-not-found ratio: ${funnel.createAfterNotFoundRate}</p>
</section>

<section class="cols">
  <div>
    <h2>Memories by type</h2>
    ${barGroup(Object.entries(writes.memoriesByType).sort(([, a], [, b]) => b - a))}
  </div>
  <div>
    <h2>Memories by scope</h2>
    ${barGroup(Object.entries(writes.memoriesByScope).sort(([, a], [, b]) => b - a))}
  </div>
</section>

<section>
  <h2>Store health</h2>
  <div class="tiles">
    ${statTile('Memories on disk', String(store.totalMemories))}
    ${statTile('Archived', pct(store.archivedRate))}
    ${statTile('Never retrieved', pct(store.neverRetrievedRate), 'of active, within the log window')}
    ${statTile('Stale', String(store.staleMemories.length), `untouched ${STALE_AFTER_DAYS}d and unread`)}
    ${statTile('Unreadable files', String(store.unreadableFiles.length))}
  </div>
  <h2 style="margin-top:1.5rem">Stale memories</h2>
  ${staleTable(store)}
</section>

<section class="cols">
  <div>
    <h2>Most retrieved</h2>
    ${topRetrievedTable(metrics, store)}
  </div>
  <div>
    <h2>Activity by project</h2>
    ${projectTable(metrics, store)}
  </div>
</section>

<section>
  <h2>By variant, policy, server, and client</h2>
  ${segmentTable(metrics)}
  <p class="note">Only compare rows that differ on one axis. A model or client change moving at
  the same time as an instruction change makes both uninterpretable.</p>
</section>

<section>
  <h2>Memories created (cumulative)</h2>
  ${memoriesOverTime(metrics)}
</section>

<section>
  <h2>Tool calls by day</h2>
  ${callsByDayTable(metrics)}
</section>

<section class="cols">
  <div>
    <h2>Tool calls by tool</h2>
    ${barGroup(Object.entries(metrics.callsByTool).sort(([a], [b]) => (a < b ? -1 : 1)))}
  </div>
  <div>
    <h2>Errors by code</h2>
    ${barGroup(Object.entries(metrics.errorsByCode).sort(([, a], [, b]) => b - a))}
  </div>
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
