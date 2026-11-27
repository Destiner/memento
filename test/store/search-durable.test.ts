import { fileURLToPath, URL } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';

import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { MemoryIndex, type SearchHit, type SearchOptions } from '../../src/store/search-index.js';
import type { Operation } from '../fixtures/search-worker/worker.js';
import { memoryRecord, PROJECT_A, PROJECT_B } from '../helpers/memories.js';

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../fixtures/search-worker/wrangler.toml', import.meta.url)),
    dev: { remote: false, persist: false, server: { port: 0 } },
  });
}, 30_000);

afterAll(async () => {
  await worker?.dispose();
});

async function run(object: string, ...operations: Operation[]): Promise<unknown[]> {
  const response = await worker.fetch(`http://localhost/${object}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(operations),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

const projectScope = { kind: 'projects' as const, project_ids: [PROJECT_A] };
const globalScope = { kind: 'global' } as const;

function entry(
  id: string,
  body: string,
  overrides: Partial<MemoryRecord> = {},
): [MemoryRecord, string] {
  return [
    memoryRecord({ id, title: 'Operational note', description: 'Recorded finding.', ...overrides }),
    body,
  ];
}

function search(query: string, options: Partial<SearchOptions> = {}) {
  return { op: 'search', query, options: { scope: projectScope, limit: 10, ...options } } as const;
}

function hitIds(result: unknown) {
  expect(Array.isArray(result), JSON.stringify(result)).toBe(true);
  return (result as SearchHit[]).map((hit) => hit.id);
}

test.each([
  ['workerState', 'workerStates and workerStateBackup', 'Use workerState.current.'],
  ['ÉCHO_FLAG', 'ÉCHO_FLAG_extra', 'Use écho_flag.sh.'],
  ['--no-cache', '--no-cache-dir', 'Pass (--no-cache).'],
  ['src/auth/session.ts', 'src/auth/session.ts.map', 'Open src/auth/session.ts.'],
  ['C++', 'C#', 'Compile with C++.'],
  ['"foo_bar baz_qux"', 'foo_bar and baz_qux', 'Use (foo_bar baz_qux).'],
])('matches literal %s exactly, even behind higher BM25 decoys', async (query, decoy, exact) => {
  const entries = Array.from({ length: 40 }, (_, i) =>
    entry(`decoy-${i}`, decoy, { title: decoy }),
  );
  entries.push(
    entry('long-exact', `${exact} ${'Background context for deployment. '.repeat(100)}`),
  );
  const [, found] = await run(
    `literal-${encodeURIComponent(query)}`,
    { op: 'upsert', entries },
    search(query, { limit: 1 }),
  );
  expect(hitIds(found)).toEqual(['long-exact']);
});

test('preserves independent literal clause pools, deduplication, and output limits', async () => {
  const entries = Array.from({ length: 40 }, (_, i) =>
    entry(`left-${i}`, 'left_flag right_flag_extra', {
      title: 'left_flag right_flag_extra',
      status: 'archived',
    }),
  );
  entries.push(entry('right-only', 'Background context. '.repeat(100), { title: 'right_flag' }));
  const [, results, limited, after] = await run(
    'pools',
    { op: 'upsert', entries },
    search('left_flag; right_flag', { limit: 2 }),
    search('left_flag', { limit: 1 }),
    { op: 'count' },
  );
  expect(hitIds(results)).toEqual(['right-only', 'left-0']);
  expect(hitIds(limited)).toEqual(['left-0']);
  expect(after).toBe(41);
});

test('matches Node FTS scores, BM25 order, dedupe, and project/type/status predicates', async () => {
  const shared = { kind: 'projects' as const, project_ids: [PROJECT_A, PROJECT_B] };
  const archived = { scope: shared, status: 'archived', type: 'decision_history' } as const;
  const entries = [
    entry('shared', 'Retry deliveries with reconcileLedger.', archived),
    entry('one', 'Workers are retrying café deliveries with reconcileLedger.', {
      ...archived,
      scope: projectScope,
    }),
    entry('other', 'Use reconcileLedger.', {
      scope: { kind: 'projects', project_ids: [PROJECT_B] },
    }),
    entry('type', 'Use reconcileLedger.', { ...archived, type: 'debugging_pattern' }),
    entry('status', 'Use reconcileLedger.', { ...archived, status: 'active' }),
    entry('global', 'Use reconcileLedger.', { scope: globalScope }),
    entry('japanese', '認証失敗'),
  ];
  const searches = [
    search('worker retry cafe'),
    search('認証失敗'),
    search('reconcileLedger', {
      scope: { ...archived.scope, match: 'all' },
      types: ['decision_history'],
      status: ['archived'],
    }),
    search('reconcileLedger', { scope: { ...archived.scope, match: 'any' } }),
    search('reconcileLedger', { scope: globalScope }),
    search('database credentials misconfiguration'),
  ];
  const options = {
    title: 'retry deliveries completely unrelated words',
    description: '',
    scope: projectScope,
    limit: 1,
  };
  const [, ...results] = await run('scope', { op: 'upsert', entries }, ...searches, {
    op: 'candidates',
    options,
  });
  const node = new MemoryIndex();
  try {
    for (const item of entries) node.upsert(...item);
    expect(results).toEqual([
      ...searches.map(({ query, options }) => node.search(query, options)),
      node.candidates(options),
    ]);
  } finally {
    node.close();
  }
  expect(results.slice(0, 3).map(hitIds)).toEqual([['one'], ['japanese'], ['shared']]);
  expect(hitIds(results[3]).sort()).toEqual(['one', 'other', 'shared', 'status', 'type']);
  expect(hitIds(results[4])).toEqual(['global']);
  expect(hitIds(results[5])).toEqual([]);
  expect(hitIds(results[6])).toEqual(['shared']);
  expect((results[0] as SearchHit[])[0]!.bm25).toBeLessThan(0);
});

test('initializes and reopens the schema without losing records or leaving scratch tokens', async () => {
  expect(await run('schema', { op: 'count' }, { op: 'reopen' }, { op: 'scratchCount' })).toEqual([
    0, 0, 0,
  ]);
  const invalid = entry('changing', 'Should never appear.', { title: null as unknown as string });
  const expanded = Array.from({ length: 65 }, (_, i) => `word${i}`).join('\u034f');
  const results = await run(
    'schema',
    { op: 'upsert', entries: [entry('changing', 'Use oldSessionToken.')] },
    { op: 'reopen' },
    { op: 'upsert', entries: [invalid] },
    search('oldSessionToken'),
    { op: 'upsert', entries: [entry('changing', 'Use newSessionToken.', { status: 'archived' })] },
    { op: 'status', id: 'changing' },
    { op: 'reopen' },
    search('oldSessionToken'),
    search('newSessionToken'),
    { op: 'scratchCount' },
    { op: 'remove', id: 'changing' },
    search('newSessionToken'),
    search(expanded),
    { op: 'scratchCount' },
    { op: 'upsert', entries: [entry('fresh', 'Use freshSessionToken.')] },
    { op: 'clear' },
    { op: 'reopen' },
    search('freshSessionToken'),
    { op: 'status', id: 'fresh' },
  );
  expect(results).toEqual([
    null,
    1,
    { error: expect.stringContaining('NOT NULL') },
    expect.arrayContaining([expect.objectContaining({ id: 'changing' })]),
    null,
    'archived',
    1,
    [],
    expect.arrayContaining([expect.objectContaining({ id: 'changing', status: 'archived' })]),
    0,
    null,
    [],
    { error: expect.stringContaining('distinct terms') },
    0,
    null,
    null,
    0,
    [],
    null,
  ]);
});
