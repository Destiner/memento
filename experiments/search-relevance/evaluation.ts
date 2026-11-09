import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  memoryScopeSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  searchMemoriesInputSchema,
  validateMemoryFrontmatter,
  verificationSchema,
} from '../../src/store/memory-schema.js';
import type { MemoryRecord } from '../../src/store/memory-schema.js';

export const LIMIT = 5;
const text = z.string().trim().min(1);
const seedSchema = z
  .object({
    version: z.union([text, z.number().int().nonnegative()]),
    projects: z.array(z.object({ id: text.regex(/^prj_[A-Za-z0-9_-]+$/), name: text }).strict()),
    memories: z.array(
      z
        .object({
          id: text.regex(/^mem_[A-Za-z0-9_-]+$/),
          title: text,
          description: text,
          body: text,
          scope: memoryScopeSchema,
          status: memoryStatusSchema.default('active'),
          type: memoryTypeSchema,
          verification: verificationSchema.optional(),
        })
        .strict(),
    ),
    queries: z.array(
      z
        .object({
          id: text,
          query: text,
          scope: searchMemoriesInputSchema.shape.scope,
          types: searchMemoriesInputSchema.shape.types,
          status: searchMemoriesInputSchema.shape.status,
          split: text.default('unspecified'),
          category: text.optional(),
          rationale: text.optional(),
          relevant: z.array(text),
        })
        .strict(),
    ),
  })
  .passthrough();
export type Seed = z.infer<typeof seedSchema>;
export type Query = Seed['queries'][number];
export type Document = Seed['memories'][number];

export function record(doc: Document): MemoryRecord {
  return validateMemoryFrontmatter({
    id: doc.id,
    title: doc.title,
    description: doc.description,
    scope: doc.scope,
    type: doc.type,
    status: doc.status,
    provenance: { source: 'agent_observed', verification: doc.verification ?? 'observed_once' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...(doc.status === 'archived' ? { archive_reason: 'Synthetic retired decision.' } : {}),
  });
}

export function eligible(doc: Document, q: Query): boolean {
  if (!q.status.includes(doc.status) || (q.types && !q.types.includes(doc.type))) return false;
  if (q.scope.kind === 'global') return doc.scope.kind === 'global';
  if (doc.scope.kind !== 'projects') return false;
  const ids = doc.scope.project_ids;
  return q.scope.match === 'all'
    ? q.scope.project_ids.every((id) => ids.includes(id))
    : q.scope.project_ids.some((id) => ids.includes(id));
}

function unique(ids: string[], label: string): void {
  assert.equal(new Set(ids).size, ids.length, `Duplicate ${label}`);
}
export function parseSeed(raw: unknown): Seed {
  const seed = seedSchema.parse(raw);
  unique(
    seed.projects.map((p) => p.id),
    'project IDs',
  );
  unique(
    seed.memories.map((d) => d.id),
    'document IDs',
  );
  unique(
    seed.queries.map((q) => q.id),
    'query IDs',
  );
  const projects = new Set(seed.projects.map((p) => p.id));
  const checkScope = (scope: Document['scope']) => {
    if (scope.kind === 'projects') {
      unique(scope.project_ids, 'scope project IDs');
      assert(
        scope.project_ids.every((id) => projects.has(id)),
        'Unregistered project ID',
      );
    }
  };
  for (const doc of seed.memories) {
    record(doc);
    checkScope(doc.scope);
  }
  for (const q of seed.queries) {
    searchMemoriesInputSchema.parse(searchInput(q));
    checkScope(q.scope);
    unique(q.relevant, `labels for ${q.id}`);
    for (const id of q.relevant) {
      assert(
        seed.memories.some((d) => d.id === id && eligible(d, q)),
        `Ineligible label ${q.id}: ${id}`,
      );
    }
  }
  return seed;
}
export function searchInput(q: Query) {
  return { query: q.query, scope: q.scope, types: q.types, status: q.status, limit: LIMIT };
}
export interface Hit {
  id: string;
  score: number;
  bm25?: number;
}
export interface Row {
  queryId: string;
  split: string;
  method: 'legacy' | 'current';
  relevant: string[];
  eligibleCount: number;
  hits: Hit[];
  misses: string[];
}
export function assertHits(hits: Hit[], seed: Seed, q: Query): void {
  assert(hits.length <= LIMIT, 'Too many hits');
  unique(
    hits.map((h) => h.id),
    'hit IDs',
  );
  for (const hit of hits) {
    assert(Number.isFinite(hit.score), 'Nonfinite score');
    assert(
      seed.memories.some((d) => d.id === hit.id && eligible(d, q)),
      `Ineligible hit ${q.id}: ${hit.id}`,
    );
  }
}
const ratio = (n: number, d: number) => (d ? n / d : null);
export function summarize(rows: Row[]) {
  const positive = rows.filter((r) => r.relevant.length > 0);
  const negative = rows.filter((r) => r.relevant.length === 0);
  const nonempty = negative.filter((r) => r.eligibleCount > 0);
  const tp = (r: Row) => r.hits.filter((h) => r.relevant.includes(h.id)).length;
  const truePositives = rows.reduce((n, r) => n + tp(r), 0);
  const returned = rows.reduce((n, r) => n + r.hits.length, 0);
  const relevant = positive.reduce((n, r) => n + r.relevant.length, 0);
  const attainable = positive.reduce((n, r) => n + Math.min(LIMIT, r.relevant.length), 0);
  const fp = (rs: Row[]) => rs.filter((r) => r.hits.length > 0).length;
  return {
    queries: rows.length,
    positives: positive.length,
    noAnswerQueries: negative.length,
    nonemptyPoolNoAnswerQueries: nonempty.length,
    returned,
    truePositives,
    irrelevant: returned - truePositives,
    relevant,
    attainableRelevantAt5: attainable,
    returnedPrecision: ratio(truePositives, returned),
    microRecallAt5: ratio(truePositives, relevant),
    cappedAttainableRecallAt5: ratio(truePositives, attainable),
    ndcgAt5: ratio(
      positive.reduce((sum, r) => {
        const discount = (i: number) => 1 / Math.log2(i + 2);
        const dcg = r.hits.reduce(
          (n, h, i) => n + (r.relevant.includes(h.id) ? discount(i) : 0),
          0,
        );
        const ideal = r.relevant.slice(0, LIMIT).reduce((n, _, i) => n + discount(i), 0);
        return sum + dcg / ideal;
      }, 0),
      positive.length,
    ),
    noAnswerFalsePositiveQueries: fp(negative),
    noAnswerFalsePositiveRate: ratio(fp(negative), negative.length),
    nonemptyPoolNoAnswerFalsePositiveQueries: fp(nonempty),
    nonemptyPoolNoAnswerFalsePositiveRate: ratio(fp(nonempty), nonempty.length),
    missedPositiveQueries: positive.filter((r) => tp(r) === 0).length,
    missedRelevantPairs: relevant - truePositives,
  };
}
