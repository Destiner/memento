import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { MemoryIndex, type SearchOptions } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A, PROJECT_B } from '../helpers/memories.js';

const scope = { kind: 'projects' as const, project_ids: [PROJECT_A] };

describe('search evidence regression contracts', () => {
  let index: MemoryIndex;
  const directories: string[] = [];

  beforeEach(() => {
    index = new MemoryIndex();
  });
  afterEach(() => {
    index.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function add(id: string, body: string, overrides: Partial<MemoryRecord> = {}) {
    index.upsert(
      memoryRecord({
        id,
        title: 'Operational note',
        description: 'Recorded finding.',
        ...overrides,
      }),
      body,
    );
  }
  function search(query: string, options: Partial<SearchOptions> = {}) {
    return index.search(query, { scope, limit: 10, ...options });
  }
  function ids(query: string, options: Partial<SearchOptions> = {}) {
    return search(query, options).map((hit) => hit.id);
  }

  test('shared function words are not evidence for an unrelated question', () => {
    add('tea', 'We use the kettle in the kitchen for tea after lunch.');
    expect(ids('How should we rotate database credentials in the cluster?')).toEqual([]);
    expect(ids('the and for with')).toEqual([]);
  });

  test('a requested limit does not pad a useful answer with incidental overlap', () => {
    add('answer', 'Database credential rotation requires dual passwords during deployment.');
    add('incidental', 'Database dashboards display weekly revenue.');
    add('unrelated', 'Deployment artwork uses a blue background.');
    const query = 'database credential rotation dual passwords';
    expect(ids(query, { limit: 20 })).toEqual(['answer']);
    index.remove('answer');
    expect(ids(query, { limit: 20 })).toEqual([]);
  });

  test('broad keyword searches can return useful partial coverage', () => {
    add('cache', 'Cache invalidation happens when a document changes.');
    expect(ids('cache invalidation replication')).toContain('cache');
  });

  test.each([
    ['refreshAccessToken', 'refreshAccessTokenBackup'],
    ['refresh_access_token', 'refresh_access_token_backup'],
    ['"connection pool exhausted"', 'connection pool exhaustedness'],
    ['src/auth/session.ts', 'src/auth/session.tsx'],
  ])(
    'exact body reference %s survives a verbose question without accepting %s',
    (reference, decoy) => {
      const literal = reference.replaceAll('"', '');
      add('exact', `Recovery procedure: inspect ${literal}.`);
      add('prefix', `Recovery procedure: inspect ${decoy}.`);
      const query = `Where should we investigate ${reference} when production authentication fails during deployment despite healthy networking and sufficient capacity?`;
      expect(ids(query)).toEqual(['exact']);
    },
  );

  test('punctuation distinguishes C++ from C#', () => {
    add('cpp', 'C++ compilation requires the native toolchain.');
    add('csharp', 'C# compilation requires the managed toolchain.');
    expect(ids('C++ compilation')).toEqual(['cpp']);
    expect(ids('C# compilation')).toEqual(['csharp']);
  });

  test('SQLite stemming, diacritics, and non-English words remain searchable', () => {
    add('english', 'Workers are retrying café deliveries.');
    add('japanese', '認証失敗');
    expect(ids('worker retry cafe')).toContain('english');
    expect(ids('認証失敗')).toEqual(['japanese']);
  });

  test('separate questions admit complementary answers, not single-word distractions', () => {
    add('rotation', 'Rotate database credentials with overlapping passwords.');
    add('rollback', 'Rollback deployments by restoring the previous image.');
    add('noise', 'Database charts show revenue.');
    expect(
      ids('How do we rotate database credentials? How do we rollback deployments?').sort(),
    ).toEqual(['rollback', 'rotation']);
  });

  test('out-of-scope documents cannot change accepted scores or ordering', () => {
    add('full', 'Cache invalidation replication protocol.');
    add('partial', 'Cache invalidation procedure.');
    const query = 'cache invalidation replication';
    const before = search(query).map(({ id, score }) => ({ id, score }));
    expect(before.length).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) {
      add(`other-${i}`, 'Cache invalidation replication protocol.', {
        scope: { kind: 'projects', project_ids: [PROJECT_B] },
      });
    }
    expect(search(query).map(({ id, score }) => ({ id, score }))).toEqual(before);
  });

  test('specific archived evidence beats an active generic answer, but active wins equal evidence', () => {
    add('generic', 'Session recovery advice.', { title: 'Session troubleshooting' });
    add('archived', 'Session recovery calls restoreSessionState.', { status: 'archived' });
    expect(ids('How does restoreSessionState handle session recovery?')[0]).toBe('archived');
    add('active', 'Session recovery calls restoreSessionState.');
    expect(ids('How does restoreSessionState handle session recovery?')).toEqual([
      'active',
      'archived',
    ]);
  });

  test('strong provenance cannot rescue irrelevant lexical evidence', () => {
    add('verified', 'Database billing reports.', {
      provenance: { source: 'user_stated', verification: 'observed_once' },
    });
    expect(ids('database credential rotation overlapping passwords')).toEqual([]);
  });

  test('scope all, type, and status constrain evidence and exact-reference rescue', () => {
    add('eligible', 'Use reconcileLedger for recovery.', {
      scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
      type: 'decision_history',
      status: 'archived',
    });
    add('one-project', 'Use reconcileLedger for recovery.', {
      type: 'decision_history',
      status: 'archived',
    });
    add('wrong-type', 'Use reconcileLedger for recovery.', {
      scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
      status: 'archived',
    });
    add('wrong-status', 'Use reconcileLedger for recovery.', {
      scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
      type: 'decision_history',
    });
    add('global', 'Use reconcileLedger for recovery.', { scope: { kind: 'global' } });
    expect(
      ids('reconcileLedger', {
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B], match: 'all' },
        types: ['decision_history'],
        status: ['archived'],
      }),
    ).toEqual(['eligible']);
  });

  test('dedupe retains broad archived neighbours that search abstains from returning', () => {
    add('broad', 'Database billing reports.', { title: 'Database reports', status: 'archived' });
    const query = 'database credential rotation overlapping passwords';
    expect(ids(query)).toEqual([]);
    expect(
      index.candidates({ title: query, description: '', scope }).map((hit) => hit.id),
    ).toContain('broad');
  });

  test('updates, removals, clear, and reopening do not retain stale token evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memento-search-evidence-'));
    directories.push(directory);
    const path = join(directory, 'index.sqlite');
    index.close();
    index = new MemoryIndex(path);
    add('changing', 'Use oldSessionToken.');
    expect(ids('oldSessionToken')).toEqual(['changing']);
    add('changing', 'Use newSessionToken.');
    expect(ids('oldSessionToken')).toEqual([]);
    expect(ids('newSessionToken')).toEqual(['changing']);
    index.close();
    index = new MemoryIndex(path);
    expect(ids('oldSessionToken')).toEqual([]);
    expect(ids('newSessionToken')).toEqual(['changing']);
    index.remove('changing');
    expect(ids('newSessionToken')).toEqual([]);
    add('cleared', 'Use clearedSessionToken.');
    expect(ids('clearedSessionToken')).toEqual(['cleared']);
    index.clear();
    add('fresh', 'Use freshSessionToken.');
    expect(ids('clearedSessionToken')).toEqual([]);
    expect(ids('freshSessionToken')).toEqual(['fresh']);
    index.close();
    index = new MemoryIndex(path);
    expect(ids('clearedSessionToken')).toEqual([]);
    expect(ids('freshSessionToken')).toEqual(['fresh']);
  });

  test.each(['foo_bar', 'ÉCHO_FLAG'])(
    'rescue filters suffix decoys before limiting %s',
    (literal) => {
      for (let i = 0; i < 40; i++) add(`decoy-${i}`, `${literal}_extra`);
      add('exact', `Use ${literal}. ${'Background operational context. '.repeat(100)}`);
      expect(ids(literal, { limit: 1 })).toEqual(['exact']);
    },
  );

  test.each([
    ['--no-cache', '--no-cache-dir'],
    ['config.json', 'config.json.bak'],
    ['src/auth/session.ts', 'src/auth/session.ts.map'],
  ])('literal %s rejects a continuation %s but permits prose punctuation', (literal, suffix) => {
    add('suffix', `Use ${suffix}.`);
    add('exact', `Use (${literal}).`);
    expect(ids(`${literal}.`)).toEqual(['exact']);
  });

  test('plain identifiers match member access and executable extensions, not longer names', () => {
    add('script', 'Launch worker_loop.sh.');
    add('member', 'Inspect taskState.current.');
    add('wrong', 'Launch worker_loop_backup.sh and inspect taskStateBackup.');
    expect(ids('worker_loop')).toEqual(['script']);
    expect(ids('taskState')).toEqual(['member']);
  });

  test('quoted references remain atomic, even around clause boundaries', () => {
    add('partial', 'Use foo_bar and unrelated helpers.');
    add('exact', 'Use foo_bar baz_qux.');
    expect(ids('"foo_bar baz_qux"')).toEqual(['exact']);
    expect(ids('foo_bar baz_qux')).toEqual(['exact']);
    expect(ids('"foo_bar and how baz_qux"')).toEqual([]);
    expect(ids('"foo_bar? baz_qux"')).toEqual([]);
  });

  test('explicit literal stop words survive prose stop-word filtering', () => {
    add('flag', 'Pass --no to suppress output.');
    add('phrase', 'The exact banner text is the and for.');
    expect(ids('--no')).toEqual(['flag']);
    expect(ids('"the and for"')).toEqual(['phrase']);
    expect(ids('the and for')).toEqual([]);
  });

  test('oversized queries fail explicitly instead of silently dropping requirements', () => {
    add('found', 'A short ordinary memory.');
    const words = Array.from({ length: 64 }, (_, i) => `term${i}`);
    expect(() => ids(`${words.join(' ')} missing_flag`)).toThrow(/distinct terms/);
    expect(() => ids('a'.repeat(4097))).toThrow(/characters/);
    // unicode61 splits this combining mark even though the JS surface token does not.
    expect(() => ids(Array.from({ length: 65 }, (_, i) => `word${i}`).join('\u034f'))).toThrow(
      /distinct terms/,
    );
    expect(() => ids('short '.repeat(100))).not.toThrow();
    index.clear();
    expect(() => ids(Array.from({ length: 65 }, (_, i) => `word${i}`).join('\u034f'))).toThrow(
      /distinct terms/,
    );
  });

  test('an exact body identifier survives more than thirty stronger broad lexical candidates', () => {
    for (let i = 0; i < 45; i++) {
      add(`generic-${i}`, 'Production authentication deployment recovery troubleshooting.', {
        title: 'Production authentication deployment recovery troubleshooting',
        description: 'Production authentication deployment recovery troubleshooting.',
      });
    }
    add('specific', `Use renewSessionLease. ${'Background operational context. '.repeat(100)}`);
    expect(
      ids('renewSessionLease production authentication deployment recovery troubleshooting', {
        limit: 1,
      }),
    ).toEqual(['specific']);
  });
});
