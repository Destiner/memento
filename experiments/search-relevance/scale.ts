// Run with: node --import tsx experiments/search-relevance/scale.ts /new/outside/repo.json
// Synthetic ranking only: no files, store resolution, server, fixtures, or network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SERVER_VERSION } from '../../src/server.js';
import { memoryFrontmatterSchema, type MemoryRecord } from '../../src/store/memory-schema.js';
import { MemoryIndex, type SearchHit, type SearchOptions } from '../../src/store/search-index.js';
import { SEARCH_RANKER_VERSION } from '../../src/store/search-relevance.js';
import { MemoryIndex as LegacyIndex } from './legacy-index.js';
import { assertPrivateOutput, writePrivateOutput } from './output.js';

const [output, ...extra] = process.argv.slice(2);
assert(output && !extra.length, 'Usage: scale.ts <new-output-outside-repo.json>');
await assertPrivateOutput(output);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// The 5k literal-rescue cases take minutes per call. Keep them intact rather
// than dropping them, capping decoys, or excluding their samples from the report.
const WARMUP = 1;
const REPETITIONS = 3;
const options: SearchOptions = { scope: { kind: 'global' }, status: ['active'], limit: 5 };
const topics = [
  [
    'postgres connection pool exhaustion',
    'PoolTimeoutError',
    'Bound concurrent transactions before increasing the pool.',
  ],
  [
    'react stale closure subscription',
    'useSyncExternalStore',
    'Subscribe with a stable snapshot to avoid stale closures.',
  ],
  [
    'sqlite database locked transaction',
    'SQLITE_BUSY',
    'Keep write transactions short and configure busy timeout.',
  ],
  [
    'typescript module resolution exports',
    'ERR_MODULE_NOT_FOUND',
    'Use explicit module extensions for NodeNext exports.',
  ],
  [
    'webhook signature validation payload',
    'verify_signature',
    'Validate the raw payload before parsing JSON.',
  ],
  [
    'redis reconnect socket backoff',
    'ECONNRESET',
    'Invalidate the stale socket and apply bounded reconnect backoff.',
  ],
  [
    'docker volume file permissions',
    'EACCES',
    'Align the container user identifier with mounted file ownership.',
  ],
  [
    'vite asset cache deployment',
    'manifest.json',
    'Publish hashed assets before switching the deployment manifest.',
  ],
] as const;
type Scenario = 'mixed' | 'crowded-exact' | 'crowded-no-target';
interface Doc {
  record: MemoryRecord;
  body: string;
}
function makeDoc(i: number, title: string, description: string, body: string): Doc {
  return {
    record: memoryFrontmatterSchema.parse({
      id: `mem_SYNTH${String(i).padStart(6, '0')}`,
      title,
      description,
      type: 'debugging_pattern',
      scope: { kind: 'global' },
      status: 'active',
      provenance: { source: 'agent_observed', verification: 'observed_once' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }),
    body,
  };
}
function corpus(size: number, scenario: Scenario): Doc[] {
  return Array.from({ length: size }, (_, i) => {
    if (scenario !== 'mixed') {
      if (scenario === 'crowded-exact' && i === size - 1) {
        // Body-only exact literal is deliberately weaker in BM25 than title decoys.
        return makeDoc(
          i,
          'Historical recovery note',
          'A detailed operational observation.',
          `foo_bar ${'operational context padding '.repeat(200)}`,
        );
      }
      return makeDoc(
        i,
        `foo_bar_extra recovery ${i}`,
        'foo_bar_extra retry boundary',
        'foo_bar_extra handles a different operation.',
      );
    }
    if (i < topics.length) {
      const [keywords, identifier, explanation] = topics[i]!;
      return makeDoc(
        i,
        keywords,
        `${identifier}: ${explanation}`,
        `${explanation} Use ${identifier}.`,
      );
    }
    // Mostly realistic but unrelated notes; some shared vocabulary without identifiers.
    const category = [
      'layout spacing typography',
      'billing invoice rounding',
      'calendar timezone display',
      'image thumbnail resizing',
      'navigation keyboard focus',
      'metrics histogram aggregation',
    ][i % 6]!;
    return makeDoc(
      i,
      `${category} observation ${i}`,
      `Synthetic independent lesson about ${category}.`,
      `Keep ${category} predictable. Observation number ${i}.`,
    );
  });
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max_ms: sorted.at(-1)!,
  };
}
const rows = [];
const sqlite = new DatabaseSync(':memory:');
let sqliteVersion: unknown;
try {
  sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get();
} finally {
  sqlite.close();
}
for (const size of [1000, 5000]) {
  for (const scenario of ['mixed', 'crowded-exact', 'crowded-no-target'] as const) {
    const generationStart = performance.now();
    const docs = corpus(size, scenario);
    const generation_ms = performance.now() - generationStart;
    const corpusSha256 = createHash('sha256').update(JSON.stringify(docs)).digest('hex');
    let current: MemoryIndex | undefined;
    let legacy: LegacyIndex | undefined;
    try {
      let start = performance.now();
      current = new MemoryIndex();
      const current_init_ms = performance.now() - start;
      start = performance.now();
      legacy = new LegacyIndex();
      const legacy_init_ms = performance.now() - start;
      start = performance.now();
      for (const doc of docs) current.upsert(doc.record, doc.body);
      const current_index_ms = performance.now() - start;
      start = performance.now();
      for (const doc of docs) legacy.upsert(doc.record, doc.body);
      const legacy_index_ms = performance.now() - start;
      assert.equal(current.count(), size);
      assert.equal(legacy.count(), size);
      const queries =
        scenario === 'mixed'
          ? [
              ...topics.flatMap(([keywords, identifier], i) => [
                { label: `keyword-${i}`, text: keywords, expected: docs[i]!.record.id },
                { label: `code-${i}`, text: identifier, expected: docs[i]!.record.id },
              ]),
              { label: 'unrelated', text: 'quasar nectarine harpsichord', expected: undefined },
            ]
          : [
              {
                label: 'exact-identifier',
                text: 'foo_bar',
                expected: scenario === 'crowded-exact' ? docs.at(-1)!.record.id : undefined,
              },
            ];
      // Untimed probe proves this fixture really exceeds the production pool (30).
      let rescueEvidence;
      if (scenario === 'crowded-exact') {
        const broad = legacy.search('foo_bar', { ...options, limit: size });
        const exact = broad.find((hit) => hit.id === docs.at(-1)!.record.id);
        assert(exact, 'Exact target must be in the broad FTS result set');
        const betterBM25 = broad.filter((hit) => hit.bm25 < exact.bm25).length;
        assert(betterBM25 >= 30, 'Fixture must bury exact target below the BM25 pool');
        assert(!legacy.search('foo_bar', options).some((hit) => hit.id === exact.id));
        rescueEvidence = { decoysWithBetterBM25: betterBM25, exactAbsentFromLegacyTop5: true };
      }
      const queryRows = [];
      for (const q of queries) {
        const indices: Record<
          'current' | 'legacy',
          { search(query: string, options: SearchOptions): SearchHit[] }
        > = { current, legacy };
        const samples: Record<'current' | 'legacy', number[]> = { current: [], legacy: [] };
        const baseline: Partial<Record<'current' | 'legacy', SearchHit[]>> = {};
        // Alternate order each iteration; same limits, scope, data, and API layer.
        for (let iteration = -WARMUP; iteration < REPETITIONS; iteration++) {
          const order =
            iteration % 2 === 0
              ? (['current', 'legacy'] as const)
              : (['legacy', 'current'] as const);
          for (const method of order) {
            const t = performance.now();
            const hits = indices[method].search(q.text, options);
            const elapsed = performance.now() - t;
            if (iteration >= 0) samples[method].push(elapsed);
            assert(hits.length <= options.limit);
            assert(hits.every((hit) => hit.scope.kind === 'global' && hit.status === 'active'));
            if (baseline[method])
              assert.deepEqual(hits, baseline[method], 'Ranking changed across repetitions');
            else baseline[method] = hits;
          }
        }
        const ch = baseline.current!;
        const lh = baseline.legacy!;
        if (q.expected)
          assert(
            ch.some((hit) => hit.id === q.expected),
            `Current failed synthetic expectation: ${scenario}/${q.label}`,
          );
        else assert.equal(ch.length, 0, 'Current should abstain without a target');
        const sameOrderedIds =
          JSON.stringify(ch.map((h) => h.id)) === JSON.stringify(lh.map((h) => h.id));
        queryRows.push({
          queryLabel: q.label,
          querySha256: createHash('sha256').update(q.text).digest('hex'),
          current: stats(samples.current),
          legacy: stats(samples.legacy),
          p50Ratio: stats(samples.current).p50_ms / stats(samples.legacy).p50_ms,
          semantics: {
            currentCount: ch.length,
            legacyCount: lh.length,
            sameOrderedIds,
            overlapCount: ch.filter((h) => lh.some((l) => l.id === h.id)).length,
            currentExpectedHit: q.expected ? ch.some((h) => h.id === q.expected) : null,
            legacyExpectedHit: q.expected ? lh.some((h) => h.id === q.expected) : null,
            currentTop1Expected: q.expected ? ch[0]?.id === q.expected : null,
            legacyTop1Expected: q.expected ? lh[0]?.id === q.expected : null,
          },
        });
      }
      console.log(
        JSON.stringify({
          corpusSize: size,
          scenario,
          completedQueries: queryRows.length,
          worstCurrentP95_ms: Math.max(...queryRows.map((row) => row.current.p95_ms)),
          worstLegacyP95_ms: Math.max(...queryRows.map((row) => row.legacy.p95_ms)),
        }),
      );
      rows.push({
        corpusSize: size,
        scenario,
        corpusSha256,
        setup: {
          generation_ms,
          current_init_ms,
          legacy_init_ms,
          current_index_ms,
          legacy_index_ms,
        },
        rescueEvidence,
        queries: queryRows,
      });
    } finally {
      try {
        current?.close();
      } finally {
        legacy?.close();
      }
    }
  }
}
await writePrivateOutput(
  output,
  `${JSON.stringify({ benchmarkVersion: 1, commit, node: process.version, sqliteVersion, currentVersion: SERVER_VERSION, currentRanker: SEARCH_RANKER_VERSION, legacyVersion: '0.4.0', legacySourceCommit: 'c0cd93a', corpusGeneratorVersion: 1, warmupPerQueryPerRanker: WARMUP, repetitionsPerQueryPerRanker: REPETITIONS, limit: options.limit, measurement: 'Synchronous in-memory ranking-only including retrieval, tokenization, evidence and rescue; excludes corpus generation, index construction, MCP and file IO. Alternating execution order; fixed bounded repetitions, no outlier removal. p95 with three samples is the maximum and is NOT a robust tail estimate; diagnostic, not an SLA or production workload. Preliminary 2-warmup/10-repetition runs exceeded 240s and 1800s wall-clock limits; final repetition bound reduced explicitly, without changing corpora or rankers.', semanticPolicy: 'Deterministic results asserted per ranker; current synthetic expectations asserted. Ordered-ID parity and expected-hit parity reported, not score parity between different scoring systems.', rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify({ scale: 'passed', output, corpusSizes: [1000, 5000], scenarios: rows.length }),
);
