import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertHits,
  eligible,
  parseSeed,
  record,
  searchInput,
  summarize,
  type Row,
} from './evaluation.js';
import { MemoryIndex } from './legacy-index.js';
import { writePrivateOutput } from './output.js';

const original = () => readFile(new URL('./seed.json', import.meta.url), 'utf8').then(JSON.parse);
const row = (patch: Partial<Row> = {}): Row => ({
  queryId: 'unit',
  split: 'unit',
  method: 'legacy',
  relevant: [],
  eligibleCount: 1,
  hits: [],
  misses: [],
  ...patch,
});

describe('evaluation metrics', () => {
  it('distinguishes micro recall from capped attainable recall for >5 labels', () => {
    const relevant = Array.from({ length: 8 }, (_, i) => `mem_${i}`);
    const metrics = summarize([
      row({ relevant, hits: relevant.slice(0, 5).map((id) => ({ id, score: 1 })) }),
    ]);
    expect(metrics.microRecallAt5).toBe(5 / 8);
    expect(metrics.cappedAttainableRecallAt5).toBe(1);
    expect(metrics.ndcgAt5).toBe(1);
    expect(metrics.returnedPrecision).toBe(1);
    expect(metrics.missedRelevantPairs).toBe(3);
  });
  it('separates empty eligible pools from nonempty no-answer queries', () => {
    const metrics = summarize([
      row({ eligibleCount: 0 }),
      row({ hits: [{ id: 'mem_noise', score: 1 }] }),
    ]);
    expect(metrics.noAnswerFalsePositiveRate).toBe(0.5);
    expect(metrics.nonemptyPoolNoAnswerFalsePositiveRate).toBe(1);
    expect(metrics.returnedPrecision).toBe(0);
    expect(metrics.microRecallAt5).toBeNull();
    expect(metrics.ndcgAt5).toBeNull();
    expect(summarize([]).returnedPrecision).toBeNull();
    expect(summarize([]).nonemptyPoolNoAnswerFalsePositiveRate).toBeNull();
  });
  it('does not pad precision and penalizes missing positives', () => {
    const metrics = summarize([
      row({ relevant: ['mem_good'], hits: [{ id: 'mem_good', score: 1 }] }),
      row({ relevant: ['mem_missing'] }),
    ]);
    expect(metrics.returnedPrecision).toBe(1);
    expect(metrics.ndcgAt5).toBe(0.5);
    expect(metrics.missedPositiveQueries).toBe(1);
  });
});

describe('original fixture validation and legacy regression (never discovers other seeds)', () => {
  it('reproduces all 40 retained baseline rows exactly', async () => {
    const seed = parseSeed(await original());
    const retained = JSON.parse(
      await readFile(new URL('./results.json', import.meta.url), 'utf8'),
    ) as {
      rows: { query: string; method: string; hits: { id: string; score: number }[] }[];
    };
    const baseline = retained.rows.filter((r) => r.method === 'current');
    expect(baseline).toHaveLength(40);
    const index = new MemoryIndex();
    try {
      for (const doc of [...seed.memories].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )) {
        index.upsert(record(doc), doc.body);
      }
      for (const q of seed.queries) {
        const hits = index.search(q.query, searchInput(q));
        assertHits(hits, seed, q);
        expect(hits.map(({ id, score }) => ({ id, score }))).toEqual(
          baseline.find((r) => r.query === q.id)!.hits,
        );
      }
    } finally {
      index.close();
    }
  });
  it('rejects duplicate IDs, missing projects, invalid queries and ineligible labels', async () => {
    const seed = parseSeed(await original());
    expect(() => parseSeed({ ...seed, memories: [...seed.memories, seed.memories[0]] })).toThrow();
    expect(() => parseSeed({ ...seed, queries: [...seed.queries, seed.queries[0]] })).toThrow();
    expect(() => parseSeed({ ...seed, projects: [] })).toThrow();
    const first = seed.queries[0]!;
    for (const patch of [
      { query: ' ' },
      { status: [] },
      { types: [] },
      { relevant: ['mem_absent'] },
      { relevant: [first.relevant[0], first.relevant[0]] },
      { scope: { kind: 'global' }, relevant: [seed.memories[0]!.id] },
    ])
      expect(() => parseSeed({ ...seed, queries: [{ ...first, ...patch }] })).toThrow();
  });
  it('honors types/status/all-project eligibility and checks returned IDs', async () => {
    const seed = parseSeed(await original());
    const doc = seed.memories[0]!;
    const q = {
      ...seed.queries[0]!,
      scope: {
        kind: 'projects' as const,
        project_ids: ['prj_labA', 'prj_labB'],
        match: 'all' as const,
      },
    };
    expect(eligible(doc, q)).toBe(false);
    expect(
      eligible(doc, {
        ...q,
        scope: doc.scope.kind === 'projects' ? { ...doc.scope, match: 'any' } : doc.scope,
        status: ['archived'],
      }),
    ).toBe(false);
    expect(eligible(doc, { ...seed.queries[0]!, types: ['other'] })).toBe(false);
    expect(() => assertHits([{ id: 'mem_absent', score: 1 }], seed, q)).toThrow();
    expect(() =>
      assertHits(
        Array.from({ length: 6 }, () => ({ id: doc.id, score: 1 })),
        seed,
        q,
      ),
    ).toThrow();
  });
});

it('creates private output exclusively outside the repo', async () => {
  await expect(
    writePrivateOutput(new URL('./unsafe-unit-output.json', import.meta.url).pathname, '{}'),
  ).rejects.toThrow('outside');
  const home = await mkdtemp(join(tmpdir(), 'memento-eval-unit-'));
  try {
    const file = join(home, 'output.json');
    await writePrivateOutput(file, '{}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writePrivateOutput(file, '{}')).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
