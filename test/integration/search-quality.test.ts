// These once-held-out synthetic judgments are now spent regression fixtures,
// not an untouched evaluation set for subsequent ranking changes.
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  assertHits,
  eligible,
  parseSeed,
  record,
  searchInput,
  summarize,
  type Row,
} from '../../experiments/search-relevance/evaluation.js';
import { MemoryIndex } from '../../src/store/search-index.js';

const cases = [
  { file: 'seed.json', useful: 32, junk: 15, noAnswer: 3, missed: 1 },
  { file: 'holdout.json', useful: 25, junk: 3, noAnswer: 2, missed: 0 },
];

describe('precision and recall regression budgets', () => {
  test.each(cases)('$file preserves useful answers without filling with weak matches', (budget) => {
    const seed = parseSeed(
      JSON.parse(
        readFileSync(
          new URL(`../../experiments/search-relevance/${budget.file}`, import.meta.url),
          'utf8',
        ),
      ),
    );
    const index = new MemoryIndex();
    try {
      for (const doc of seed.memories) index.upsert(record(doc), doc.body);
      const rows: Row[] = seed.queries.map((q) => {
        const hits = index.search(q.query, searchInput(q));
        assertHits(hits, seed, q);
        return {
          queryId: q.id,
          split: q.split,
          method: 'current',
          relevant: q.relevant,
          eligibleCount: seed.memories.filter((doc) => eligible(doc, q)).length,
          hits,
          misses: q.relevant.filter((id) => !hits.some((hit) => hit.id === id)),
        };
      });
      const metrics = summarize(rows);
      expect(metrics.truePositives).toBeGreaterThanOrEqual(budget.useful);
      expect(metrics.irrelevant).toBeLessThanOrEqual(budget.junk);
      expect(metrics.noAnswerFalsePositiveQueries).toBeLessThanOrEqual(budget.noAnswer);
      expect(metrics.missedPositiveQueries).toBeLessThanOrEqual(budget.missed);
    } finally {
      index.close();
    }
  });
});
