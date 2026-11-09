// Run with: node --import tsx experiments/search-relevance/smoke.ts /new/outside/repo.json
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import { SERVER_VERSION } from '../../src/server.js';
import type { LoggedEvent } from '../../src/logging/events.js';
import { assertPrivateOutput, writePrivateOutput } from './output.js';

const [output, ...extra] = process.argv.slice(2);
assert(output && !extra.length, 'Usage: smoke.ts <new-output-outside-repo.json>');
await assertPrivateOutput(output);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const entry = join(repo, 'dist/main.js');
const entrySha256 = createHash('sha256')
  .update(await readFile(entry))
  .digest('hex');
const home = await mkdtemp(join(tmpdir(), 'memento-production-smoke-'));
const client = new Client({ name: 'offline-search-smoke', version: '1' });
// Deliberately do not inherit MEMENTO_*, NODE_OPTIONS, credentials, or a live home.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: repo,
  env: { MEMENTO_HOME: home, MEMENTO_VARIANT: 'shipped-v2' },
  stderr: 'pipe',
});
const privateText = [
  'smoke_cache_reconnect',
  'quasar nectarine harpsichord',
  'Synthetic reconnect invariant',
  'Synthetic typography preference',
  'BodySentinelReconnect: reconnect only after invalidating the stale socket.',
  'BodySentinelTypography: prefer readable monospaced labels.',
];
const started = performance.now();
let stderrBytes = 0;
transport.stderr?.on('data', (chunk: Buffer) => {
  stderrBytes += chunk.length;
});
try {
  await client.connect(transport, { timeout: 15000 });
  assert.equal(client.getServerVersion()?.version, SERVER_VERSION);
  const listed = await client.listTools();
  for (const name of ['create_memory', 'search_memories']) {
    const tool = listed.tools.find((t) => t.name === name);
    assert(tool?.description, 'Read the actual production tool instructions before calling');
  }
  // Explicitly synthetic global invariants, no forced dedupe bypass and no project fixture.
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({
      name: 'create_memory',
      arguments: {
        title: privateText[2 + i],
        description:
          i === 0
            ? `Use ${privateText[0]} for stale socket recovery.`
            : 'Use legible labels independently of project.',
        body: privateText[4 + i],
        type: i === 0 ? 'debugging_pattern' : 'preference',
        scope: { kind: 'global' },
        provenance: { source: 'agent_observed', verification: 'observed_once' },
      },
    });
    assert(!result.isError, 'Production create failed');
    const created = z
      .object({ outcome: z.literal('created'), id: z.string() })
      .parse(result.structuredContent);
    ids.push(created.id);
  }
  const searches: {
    query_id: string;
    result_count: number;
    results: { id: string; score: number }[];
  }[] = [];
  for (const query of privateText.slice(0, 2)) {
    const result = await client.callTool({
      name: 'search_memories',
      arguments: {
        query,
        scope: { kind: 'global' },
        limit: 5,
        types: ['debugging_pattern'],
        status: ['active'],
      },
    });
    assert(!result.isError, 'Production search failed');
    searches.push(
      z
        .object({
          query_id: z.string(),
          result_count: z.number(),
          results: z.array(z.object({ id: z.string(), score: z.number() })),
        })
        .parse(result.structuredContent),
    );
  }
  assert.deepEqual(
    searches[0]!.results.map((r) => r.id),
    [ids[0]],
  );
  assert.equal(searches[1]!.result_count, 0);
  const files = (await readdir(join(home, 'logs'))).filter((name) =>
    /^events-.*\.jsonl$/.test(name),
  );
  assert(files.length > 0, 'Zero event logs is not a successful smoke test');
  const raw = (
    await Promise.all(files.map((name) => readFile(join(home, 'logs', name), 'utf8')))
  ).join('');
  for (const text of [...privateText, home])
    assert(!raw.includes(text), 'Sensitive content leaked to event log');
  const events = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LoggedEvent);
  assert.equal(events.length, 4, 'Exactly four actual tool calls must reach the isolated log');
  assert.equal(new Set(events.map((e) => e.session_id)).size, 1);
  for (const event of events) {
    assert.equal(event.outcome, 'success');
    assert.equal(event.server_version, SERVER_VERSION);
    assert.equal(event.log_schema_version, 2);
    assert.equal(event.variant, 'shipped-v2');
    assert.equal(event.scope_kind, 'global');
    assert.equal(event.client_name, 'offline-search-smoke');
    assert(Number.isFinite(event.latency_ms));
    // An allowlist catches text leaks beyond the known sentinels, including fragments.
    const allowed = new Set(
      'event_id timestamp session_id tool outcome latency_ms server_version policy_version variant client_name client_version log_schema_version scope_kind project_count project_ids result_outcome memory_id memory_type verification dropped_evidence_count search_ranker result_scores search_limit search_types search_statuses result_count result_ids query_id query_length filters_used match_mode'.split(
        ' ',
      ),
    );
    assert(
      Object.keys(event).every((key) => allowed.has(key)),
      'Unexpected event field',
    );
  }
  const creates = events.filter((e) => e.tool === 'create_memory');
  assert.deepEqual(
    creates.map((e) => e.memory_id),
    ids,
  );
  assert(creates.every((e) => e.result_outcome === 'created'));
  const logged = events.filter((e) => e.tool === 'search_memories');
  assert.equal(logged.length, 2);
  for (const [i, event] of logged.entries()) {
    const result = searches[i]!;
    assert.equal(event.query_id, result.query_id);
    assert.equal(event.query_length, privateText[i]!.length);
    assert.equal(event.search_ranker, 'lexical-evidence-v1');
    assert.equal(event.search_limit, 5);
    assert.deepEqual(event.search_types, ['debugging_pattern']);
    assert.deepEqual(event.search_statuses, ['active']);
    assert.deepEqual(
      event.result_ids,
      result.results.map((r) => r.id),
    );
    assert.deepEqual(
      event.result_scores,
      result.results.map((r) => r.score),
    );
    assert.equal(event.result_count, result.result_count);
    assert(
      event.result_scores!.every((score) => Number.isFinite(score) && score >= 0 && score <= 1),
    );
  }
  await writePrivateOutput(
    output,
    `${JSON.stringify({ verificationVersion: 1, commit, node: process.version, entry: 'node dist/main.js', entrySha256, serverVersion: SERVER_VERSION, ranker: 'lexical-evidence-v1', corpusSize: 2, toolCallsVerifiedInLog: events.length, positiveCount: logged[0]!.result_count, unrelatedCount: logged[1]!.result_count, safeDiagnosticsVerified: true, noContentLogged: true, elapsed_ms: performance.now() - started, stderrBytes }, null, 2)}\n`,
  );
} finally {
  try {
    await client.close();
  } finally {
    try {
      await transport.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ smoke: 'passed', output }));
