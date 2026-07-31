import { describe, expect, test } from 'vitest';

import {
  containment,
  dice,
  memorySimilarity,
  MEMORY_DUPLICATE_THRESHOLD,
  PROJECT_DUPLICATE_THRESHOLD,
  projectSimilarity,
  tokenize,
  tokenSet,
} from '../../src/store/similarity.js';

describe('tokenize', () => {
  test('folds case, diacritics, and punctuation', () => {
    expect(tokenize('Café-Résumé: TIMEOUTS!')).toEqual(['cafe', 'resume', 'timeouts']);
  });

  test('drops stopwords and single characters', () => {
    expect(tokenize('the cause of a 502 is in the pool')).toEqual(['cause', '502', 'pool']);
  });

  // Non-latin text must produce tokens rather than an empty set, which would
  // silently disable the gate for it. The diacritic fold also decomposes Cyrillic
  // breves (й -> и), which is harmless: both sides of a comparison fold alike.
  test('keeps non-latin scripts rather than emptying the set', () => {
    expect(tokenize('таймаут очереди')).toEqual(['таимаут', 'очереди']);
  });
});

describe('dice', () => {
  test('scores identical sets 1 and disjoint sets 0', () => {
    expect(dice(tokenSet('connection pool'), tokenSet('pool connection'))).toBe(1);
    expect(dice(tokenSet('connection pool'), tokenSet('certificate rotation'))).toBe(0);
  });

  test('treats two empty sets as no evidence, not a perfect match', () => {
    expect(dice(tokenSet('the'), tokenSet('of'))).toBe(0);
  });

  test('is symmetric', () => {
    const a = tokenSet('webhook retry storm');
    const b = tokenSet('webhook retries');
    expect(dice(a, b)).toBe(dice(b, a));
  });
});

describe('containment', () => {
  test('scores a strict subset 1', () => {
    expect(containment(tokenSet('api'), tokenSet('api server'))).toBe(1);
  });

  test('scores a partial overlap by the smaller set', () => {
    expect(containment(tokenSet('api gateway'), tokenSet('api server'))).toBe(0.5);
  });
});

describe('memorySimilarity', () => {
  const pool = {
    title: 'Staging timeouts come from an exhausted connection pool',
    description: 'The 30s timeout in staging is pool exhaustion, not a slow query.',
  };

  test('an identical title is enough on its own', () => {
    const sameTitle = {
      title: '  Staging timeouts come from an exhausted CONNECTION pool!  ',
      description: 'Different wording entirely.',
    };
    expect(memorySimilarity(pool, sameTitle)).toBe(1);
  });

  test('gates a restatement of the same insight', () => {
    const restated = {
      title: 'Exhausted connection pool causes staging timeouts',
      description: 'Staging timeouts are caused by connection pool exhaustion.',
    };
    expect(memorySimilarity(pool, restated)).toBeGreaterThanOrEqual(MEMORY_DUPLICATE_THRESHOLD);
  });

  test('leaves an unrelated memory well clear of the gate', () => {
    const other = {
      title: 'The pricing feed is contractually internal-only',
      description: 'Delayed prices on the dashboard are a contract term, not a bug.',
    };
    expect(memorySimilarity(pool, other)).toBeLessThan(MEMORY_DUPLICATE_THRESHOLD);
  });

  // The description is weighted below the gate on purpose: two memories about one
  // subject share context, and only agreement on what the memory *says* — the
  // title — should be able to gate a write.
  test('the description cannot carry the gate alone', () => {
    const neighbour = {
      title: 'Certificate rotation runs on Mondays',
      description: pool.description,
    };
    expect(memorySimilarity(pool, neighbour)).toBeLessThan(MEMORY_DUPLICATE_THRESHOLD);
  });

  test('is symmetric', () => {
    const other = { title: 'Connection pool exhaustion', description: 'Staging timeouts.' };
    expect(memorySimilarity(pool, other)).toBe(memorySimilarity(other, pool));
  });
});

describe('projectSimilarity', () => {
  const api = { name: 'API', description: 'The public REST API service.' };

  // The identity-splitting shape: Dice alone scores this 0.67 on names, under the
  // gate. Containment is what catches it.
  test('gates a name that contains an existing one', () => {
    const wider = { name: 'API Server', description: 'The public REST API service.' };
    expect(projectSimilarity(api, wider)).toBeGreaterThanOrEqual(PROJECT_DUPLICATE_THRESHOLD);
  });

  test('matches against aliases, not just the name', () => {
    const aliased = {
      name: 'Backend',
      aliases: ['API'],
      description: 'Something quite different.',
    };
    expect(projectSimilarity(api, aliased)).toBeGreaterThanOrEqual(PROJECT_DUPLICATE_THRESHOLD);
  });

  test('leaves two genuinely different projects clear of the gate', () => {
    const dashboard = { name: 'Dashboard', description: 'Customer-facing web dashboard.' };
    expect(projectSimilarity(api, dashboard)).toBeLessThan(PROJECT_DUPLICATE_THRESHOLD);
  });

  test('does not gate two siblings sharing one qualifier', () => {
    const billingApi = { name: 'Billing API', description: 'Project Billing API.' };
    const billingWeb = { name: 'Billing Web', description: 'Project Billing Web.' };
    expect(projectSimilarity(billingApi, billingWeb)).toBeLessThan(PROJECT_DUPLICATE_THRESHOLD);
  });
});
