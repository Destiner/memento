// Explicit fixture only. No server, home resolution, live store, network, or models.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { orderMemoryMetadata } from '../../src/store/memory-fields.js';
import { searchMemories } from '../../src/store/memory-search.js';
import { createProject } from '../../src/store/project-create.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex, type SearchHit } from '../../src/store/search-index.js';
import {
  assertHits,
  eligible,
  LIMIT,
  parseSeed,
  record,
  searchInput,
  summarize,
  type Row,
} from './evaluation.js';
import { MemoryIndex as LegacyIndex } from './legacy-index.js';
import { assertPrivateOutput, writePrivateOutput } from './output.js';

const [seedPath, outputPath, flag, ...extra] = process.argv.slice(2);
assert(
  seedPath && outputPath && !extra.length && (flag === undefined || flag === '--timing'),
  'Usage: compare.ts <explicit-seed.json> <new-output.json> [--timing]',
);
await assertPrivateOutput(outputPath);
const seedBytes = await readFile(seedPath, 'utf8');
const raw: unknown = JSON.parse(seedBytes);
const seed = parseSeed(raw);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const home = await mkdtemp(join(tmpdir(), 'memento-search-compare-'));
let current: MemoryIndex | undefined;
let legacy: LegacyIndex | undefined;
try {
  current = new MemoryIndex();
  legacy = new LegacyIndex();
  const memoriesDir = join(home, 'memories');
  const projectsDir = join(home, 'projects');
  await mkdir(memoriesDir);
  for (const project of seed.projects) {
    await createProject(
      { name: project.name, description: 'Offline evaluation fixture.' },
      { projectsDir, makeId: () => project.id },
    );
  }
  for (const doc of seed.memories) {
    await writeFile(
      join(memoriesDir, `${doc.id}.md`),
      serializeFrontmatter(orderMemoryMetadata(record(doc)), doc.body),
      { mode: 0o600 },
    );
  }
  const rebuilt = await rebuildIndex(current, memoriesDir);
  assert.deepEqual(rebuilt.skipped, []);
  assert.equal(rebuilt.indexed, seed.memories.length);
  // Match historical markdown rebuild order, including tie ordering.
  for (const doc of [...seed.memories].sort((a, b) =>
    `${a.id}.md` < `${b.id}.md` ? -1 : `${a.id}.md` > `${b.id}.md` ? 1 : 0,
  )) {
    legacy.upsert(record(doc), doc.body);
  }
  const rows: Row[] = [];
  const samples: Record<'legacy' | 'current', number[]> = { legacy: [], current: [] };
  for (const q of seed.queries) {
    const input = searchInput(q);
    const startLegacy = performance.now();
    const legacyHits = legacy
      .search(q.query, input)
      .map(({ id, score, bm25 }) => ({ id, score, bm25 }));
    samples.legacy.push(performance.now() - startLegacy);
    const startCurrent = performance.now();
    const result = await searchMemories(input, {
      index: current,
      projectsDir,
      defaultLimit: LIMIT,
      maxLimit: LIMIT,
    });
    samples.current.push(performance.now() - startCurrent);
    // Preserve raw index scores as well as the real operation's rounded scores.
    const rawCurrent: SearchHit[] = current.search(q.query, input);
    assert.deepEqual(
      result.results.map((h) => ({ id: h.id, score: h.score })),
      rawCurrent.map((h) => ({ id: h.id, score: Math.round(h.score * 100) / 100 })),
    );
    const currentHits = rawCurrent.map(({ id, score, bm25 }, i) => ({
      id,
      score,
      bm25,
      returnedScore: result.results[i]!.score,
    }));
    for (const [method, hits] of [
      ['legacy', legacyHits],
      ['current', currentHits],
    ] as const) {
      assertHits(hits, seed, q);
      rows.push({
        queryId: q.id,
        split: q.split,
        method,
        relevant: q.relevant,
        eligibleCount: seed.memories.filter((d) => eligible(d, q)).length,
        hits,
        misses: q.relevant.filter((id) => !hits.some((h) => h.id === id)),
      });
    }
  }
  const scopes = [
    { kind: 'all' as const },
    ...[...new Set(seed.queries.map((q) => q.split))].map((split) => ({
      kind: 'split' as const,
      split,
    })),
  ];
  const summary = scopes.flatMap((scope) =>
    ['legacy', 'current'].map((method) => ({
      ...scope,
      method,
      ...summarize(
        rows.filter(
          (r) => r.method === method && (scope.kind === 'all' || r.split === scope.split),
        ),
      ),
    })),
  );
  const timing = flag
    ? {
        warning:
          'Tiny-corpus cold single-pass diagnostic, NOT production performance. Legacy is ranking-only; current includes project validation. Not a latency comparison.',
        samples: Object.fromEntries(
          Object.entries(samples).map(([method, values]) => {
            values.sort((a, b) => a - b);
            return [
              method,
              {
                count: values.length,
                p50_ms: values[Math.ceil(values.length * 0.5) - 1] ?? null,
                p95_ms: values[Math.ceil(values.length * 0.95) - 1] ?? null,
              },
            ];
          }),
        ),
      }
    : undefined;
  const metadata = Object.fromEntries(
    Object.entries(seed).filter(([key]) => !['memories', 'queries', 'projects'].includes(key)),
  );
  const db = new DatabaseSync(':memory:');
  let sqliteVersion: unknown;
  try {
    sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get();
  } finally {
    db.close();
  }
  await writePrivateOutput(
    outputPath,
    `${JSON.stringify(
      {
        evaluationVersion: 1,
        legacyVersion: '0.4.0',
        legacySourceCommit: 'c0cd93a',
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        nodeVersion: process.version,
        sqliteVersion,
        generatedAt: new Date().toISOString(),
        seedVersion: seed.version,
        seedSha256: sha256(seedBytes),
        seedMetadata: metadata,
        corpusSize: seed.memories.length,
        queryCount: seed.queries.length,
        normalizedCorpusSha256: sha256(JSON.stringify(seed.memories)),
        normalizedQuerySetSha256: sha256(JSON.stringify(seed.queries)),
        evaluationCorpus: 'full supplied corpus; no subsampling or split-specific indexing',
        splits: scopes
          .filter((s) => s.kind === 'split')
          .map((s) => ({
            split: s.split,
            seedVersion: seed.version,
            seedSha256: sha256(seedBytes),
            corpusSize: seed.memories.length,
            normalizedCorpusSha256: sha256(JSON.stringify(seed.memories)),
            queries: seed.queries.filter((q) => q.split === s.split).length,
            normalizedQuerySetSha256: sha256(
              JSON.stringify(seed.queries.filter((q) => q.split === s.split)),
            ),
          })),
        limit: LIMIT,
        summary,
        rows,
        ...(timing ? { timing } : {}),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  try {
    current?.close();
  } finally {
    try {
      legacy?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
