// Offline diagnostic only: no server, model, network, live store, or harness runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { orderMemoryMetadata } from '../../src/store/memory-fields.js';
import { searchMemories } from '../../src/store/memory-search.js';
import type { MemoryRecord, SearchScope } from '../../src/store/memory-schema.js';
import { createProject } from '../../src/store/project-create.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex, queryTerms } from '../../src/store/search-index.js';

interface Document {
  id: string;
  title: string;
  description: string;
  body: string;
  scope: MemoryRecord['scope'];
  status: MemoryRecord['status'];
  type: MemoryRecord['type'];
  verification?: MemoryRecord['provenance']['verification'];
}
interface Query {
  id: string;
  split: 'development' | 'heldout';
  category: string;
  query: string;
  scope: SearchScope;
  status?: MemoryRecord['status'][];
  relevant: string[];
  rationale: string;
}
interface Seed {
  version: number;
  projects: { id: string; name: string }[];
  memories: Document[];
  queries: Query[];
}
interface Hit {
  id: string;
  score: number;
  coverage?: number;
}

const LIMIT = 5;
const TIMESTAMP = '2026-01-01T00:00:00Z';
// Fixed before the first run. Query stop words only; stored text is unchanged.
const STOP = new Set(
  `a an the and or of to in on at by for from with as is are was were be been being
   do does did have has had it its this that these those we our us i you your they
   their them he she his her what which who how why when where can could should
   would will may might must shall than then so if into about only both each
   after before during through also not no`.split(/\s+/),
);

function record(doc: Document): MemoryRecord {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    scope: doc.scope,
    status: doc.status,
    type: doc.type,
    provenance: { source: 'agent_observed', verification: doc.verification ?? 'observed_once' },
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...(doc.status === 'archived' ? { archive_reason: 'Synthetic retired decision.' } : {}),
  };
}

function eligible(doc: Document, q: Query): boolean {
  if (!(q.status ?? ['active']).includes(doc.status)) return false;
  if (q.scope.kind === 'global') return doc.scope.kind === 'global';
  if (doc.scope.kind !== 'projects') return false;
  const ids = doc.scope.project_ids;
  return q.scope.match === 'all'
    ? q.scope.project_ids.every((id) => ids.includes(id))
    : q.scope.project_ids.some((id) => ids.includes(id));
}

function clean(text: string): string[] {
  return [...new Set(queryTerms(text).filter((term) => !STOP.has(term)))];
}

function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
    );
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of clean(text)) {
    for (let i = 0; i + 2 < word.length; i++) out.add(word.slice(i, i + 3));
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size + b.size === 0) return 0;
  return (2 * [...a].filter((x) => b.has(x)).length) / (a.size + b.size);
}

const seedBytes = await readFile(new URL('./seed.json', import.meta.url), 'utf8');
const seed = JSON.parse(seedBytes) as Seed;
const home = await mkdtemp(join(tmpdir(), 'memento-search-study-'));
const index = new MemoryIndex();
const db = new DatabaseSync(':memory:');
const methods = [
  'current',
  'weighted',
  'coverage_040',
  'coverage_060',
  'coverage_080',
  'fuzzy_060',
  'rrf_ungated',
  'rrf_060',
] as const;
type Method = (typeof methods)[number];

try {
  const memoriesDir = join(home, 'memories');
  const projectsDir = join(home, 'projects');
  await mkdir(memoriesDir);
  for (const project of seed.projects) {
    await createProject(
      { name: project.name, description: 'Synthetic search study.' },
      { projectsDir, makeId: () => project.id },
    );
  }
  assert.equal(new Set(seed.memories.map((d) => d.id)).size, seed.memories.length);
  for (const doc of seed.memories) {
    await writeFile(
      join(memoriesDir, `${doc.id}.md`),
      serializeFrontmatter(orderMemoryMetadata(record(doc)), doc.body),
    );
  }
  const rebuilt = await rebuildIndex(index, memoriesDir);
  assert.deepEqual(rebuilt.skipped, []);
  assert.equal(rebuilt.indexed, seed.memories.length);

  db.exec(`CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, title, description, body,
    tokenize='porter unicode61');
    CREATE VIRTUAL TABLE vocab USING fts5vocab(docs, instance);
    CREATE VIRTUAL TABLE words USING fts5(word, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE stems USING fts5vocab(words, instance);`);
  const insert = db.prepare('INSERT INTO docs (id, title, description, body) VALUES (?, ?, ?, ?)');
  for (const doc of seed.memories) insert.run(doc.id, doc.title, doc.description, doc.body);

  // Use SQLite's own stemmer for coverage, avoiding JS/FTS token disagreement.
  const allWords = [
    ...new Set([
      ...seed.memories.flatMap((d) => queryTerms(`${d.title} ${d.description} ${d.body}`)),
      ...seed.queries.flatMap((q) => queryTerms(q.query)),
    ]),
  ];
  const insertWord = db.prepare('INSERT INTO words (word) VALUES (?)');
  for (const word of allWords) insertWord.run(word);
  const stems = db.prepare('SELECT term, doc FROM stems').all() as { term: string; doc: number }[];
  const stemMap = new Map(stems.map((row) => [allWords[row.doc - 1]!, row.term]));
  const stem = (word: string) => stemMap.get(word) ?? word;
  const termSets = new Map(seed.memories.map((d) => [d.id, new Set<string>()]));
  const vocab = db.prepare('SELECT term, doc FROM vocab').all() as { term: string; doc: number }[];
  for (const row of vocab) termSets.get(seed.memories[row.doc - 1]!.id)!.add(row.term);
  const docGrams = new Map(
    seed.memories.map((d) => [d.id, trigrams(`${d.title} ${d.description}`)]),
  );

  function features(q: Query, fuzzy: boolean) {
    const docs = seed.memories.filter((d) => eligible(d, q));
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const token of termSets.get(doc.id)!) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const words = new Set(docs.flatMap((d) => clean(`${d.title} ${d.description} ${d.body}`)));
    const corrections: Record<string, string> = {};
    const terms = clean(q.query).map((word) => {
      if (fuzzy && word.length >= 5 && !df.has(stem(word))) {
        const neighbours = [...words].filter((candidate) => oneEdit(word, candidate));
        // Ambiguous corrections abstain; no expansion of already-known terms.
        if (neighbours.length === 1) {
          corrections[word] = neighbours[0]!;
          return neighbours[0]!;
        }
      }
      return word;
    });
    const queryStems = [...new Set(terms.map(stem))];
    const weight = (term: string) => Math.log1p((docs.length + 0.5) / ((df.get(term) ?? 0) + 0.5));
    const total = queryStems.reduce((sum, term) => sum + weight(term), 0);
    const coverage = (id: string) =>
      total === 0
        ? 0
        : queryStems.reduce(
            (sum, term) => sum + (termSets.get(id)!.has(term) ? weight(term) : 0),
            0,
          ) / total;
    return { docs, terms, coverage, corrections };
  }

  function search(q: Query, method: Method): Hit[] {
    if (method === 'current') {
      return index.search(q.query, {
        scope: q.scope,
        status: q.status ?? ['active'],
        limit: LIMIT,
      });
    }
    const { docs, terms, coverage } = features(q, method === 'fuzzy_060');
    if (!terms.length || !docs.length) return [];
    const sql = `SELECT id, -bm25(docs, 0, 4, 2, 1) AS score FROM docs
      WHERE docs MATCH ? AND id IN (${docs.map(() => '?').join(',')})
      ORDER BY score DESC, id ASC LIMIT 30`;
    const lexical = db
      .prepare(sql)
      .all(
        terms.map((term) => `"${term}"`).join(' OR '),
        ...docs.map((d) => d.id),
      ) as unknown as Hit[];
    let ranked = lexical;
    if (method.startsWith('rrf')) {
      const queryGrams = trigrams(q.query);
      const charRank = docs
        .map((d) => ({ id: d.id, score: dice(queryGrams, docGrams.get(d.id)!) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 30);
      const fused = new Map<string, number>();
      for (const list of [lexical, charRank]) {
        list.forEach((hit, i) => fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (60 + i + 1)));
      }
      ranked = [...fused].map(([id, score]) => ({ id, score }));
    }
    const threshold = method === 'coverage_040' ? 0.4 : method === 'coverage_080' ? 0.8 : 0.6;
    const gated = method !== 'weighted' && method !== 'rrf_ungated';
    return ranked
      .map((hit) => ({ ...hit, coverage: coverage(hit.id) }))
      .filter((hit) => !gated || hit.coverage >= threshold)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, LIMIT);
  }

  const rows: {
    query: string;
    split: Query['split'];
    method: Method;
    relevant: string[];
    hits: Hit[];
    corrections?: Record<string, string>;
  }[] = [];
  for (const q of seed.queries) {
    for (const id of q.relevant) {
      assert(
        seed.memories.some((d) => d.id === id && eligible(d, q)),
        `Invalid label ${q.id}: ${id}`,
      );
    }
    const production = await searchMemories(
      { query: q.query, scope: q.scope, status: q.status, limit: LIMIT },
      { index, projectsDir, defaultLimit: LIMIT, maxLimit: 10 },
    );
    assert.deepEqual(
      production.results.map((d) => d.id),
      search(q, 'current').map((d) => d.id),
    );
    for (const method of methods) {
      const hits = search(q, method);
      assert(
        hits.every((hit) =>
          eligible(
            seed.memories.find((d) => d.id === hit.id)!,
            q,
          ),
        ),
      );
      rows.push({
        query: q.id,
        split: q.split,
        method,
        relevant: q.relevant,
        hits: hits.map(({ id, score, coverage }) => ({ id, score, coverage })),
        ...(method === 'fuzzy_060' ? { corrections: features(q, true).corrections } : {}),
      });
    }
  }

  function summarize(split: string, method: Method) {
    const selected = rows.filter(
      (r) => r.method === method && (split === 'all' || r.split === split),
    );
    const positive = selected.filter((r) => r.relevant.length);
    const negative = selected.filter((r) => !r.relevant.length);
    const trueCount = (r: (typeof rows)[number]) =>
      r.hits.filter((h) => r.relevant.includes(h.id)).length;
    const returned = selected.reduce((sum, r) => sum + r.hits.length, 0);
    const truePositives = selected.reduce((sum, r) => sum + trueCount(r), 0);
    const relevant = positive.reduce((sum, r) => sum + r.relevant.length, 0);
    const dcg = (ids: string[], labels: string[]) =>
      ids.reduce((sum, id, i) => sum + (labels.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
    return {
      split,
      method,
      queries: selected.length,
      positives: positive.length,
      negatives: negative.length,
      returned,
      truePositives,
      irrelevant: returned - truePositives,
      // Precision among actual returned slots, not padded-to-five P@5.
      returnedPrecision: returned ? truePositives / returned : null,
      recallAt5: truePositives / relevant,
      hitAt1:
        positive.filter((r) => r.relevant.includes(r.hits[0]?.id ?? '')).length / positive.length,
      mrrAt5:
        positive.reduce((sum, r) => {
          const rank = r.hits.findIndex((h) => r.relevant.includes(h.id));
          return sum + (rank < 0 ? 0 : 1 / (rank + 1));
        }, 0) / positive.length,
      ndcgAt5:
        positive.reduce(
          (sum, r) =>
            sum +
            dcg(
              r.hits.map((h) => h.id),
              r.relevant,
            ) /
              dcg(r.relevant.slice(0, LIMIT), r.relevant),
          0,
        ) / positive.length,
      falsePositiveQueries: negative.filter((r) => r.hits.length).length,
      noAnswerFalsePositiveRate: negative.filter((r) => r.hits.length).length / negative.length,
      missedPositiveQueries: positive.filter((r) => trueCount(r) === 0).length,
    };
  }

  // Ranking-only timings: omit disk/registry validation for every method. Tiny-corpus diagnostics,
  // not a scalability benchmark; prototypes recompute eligible-scope DF per call.
  const timing: Record<string, { p50_ms: number; p95_ms: number }> = {};
  for (const method of methods) {
    for (const q of seed.queries) search(q, method);
    const samples: number[] = [];
    for (let repeat = 0; repeat < 20; repeat++) {
      for (const q of seed.queries) {
        const start = performance.now();
        search(q, method);
        samples.push(performance.now() - start);
      }
    }
    samples.sort((a, b) => a - b);
    timing[method] = {
      p50_ms: samples[Math.ceil(samples.length * 0.5) - 1]!,
      p95_ms: samples[Math.ceil(samples.length * 0.95) - 1]!,
    };
  }

  const probe = new MemoryIndex();
  let scoreProbe;
  try {
    const doc = seed.memories.find((d) => d.id === 'mem_gsqlite')!;
    probe.upsert(record(doc), doc.body);
    const opts = { scope: { kind: 'global' as const }, status: ['active' as const], limit: 5 };
    const before = probe.search('SQLite', opts)[0]!;
    for (let i = 0; i < 50; i++) {
      const noise = {
        ...doc,
        id: `mem_noise${i}`,
        title: 'Unrelated pottery',
        description: 'Glazing clay bowls.',
        body: 'Kiln ceramic temperatures.',
        scope: { kind: 'projects' as const, project_ids: ['prj_labA'] },
      };
      probe.upsert(record(noise), noise.body);
    }
    const after = probe.search('SQLite', opts)[0]!;
    scoreProbe = {
      explanation:
        'Same query, same sole eligible document; only out-of-scope documents were added.',
      before: { score: before.score, bm25: before.bm25 },
      after: { score: after.score, bm25: after.bm25 },
    };
  } finally {
    probe.close();
  }
  const output = {
    experimentVersion: 1,
    seedVersion: seed.version,
    seedSha256: createHash('sha256').update(seedBytes).digest('hex'),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nodeVersion: process.version,
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get(),
    generatedAt: new Date().toISOString(),
    limit: LIMIT,
    corpusSize: seed.memories.length,
    summary: ['all', 'development', 'heldout'].flatMap((split) =>
      methods.map((m) => summarize(split, m)),
    ),
    timing,
    scoreProbe,
    rows,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (process.argv[2]) await writeFile(process.argv[2], json);
  else process.stdout.write(json);
} finally {
  index.close();
  db.close();
  await rm(home, { recursive: true, force: true });
}
