import { describe, expect, test } from 'vitest';

import {
  buildProvenance,
  mergeProvenance,
  mergeScope,
  normalizeEvidence,
  orderMemoryMetadata,
  resolveVerification,
} from '../../src/store/memory-fields.js';
import {
  validateMemoryFrontmatter,
  type EvidenceEntry,
  type MemoryProvenance,
  type MemoryScope,
} from '../../src/store/memory-schema.js';

const record = validateMemoryFrontmatter({
  id: 'mem_TEST0001',
  title: 'Webhook retries read as duplicate deliveries',
  description: 'The idempotency key derives from the payload hash, so a mutated retry slips past.',
  scope: { kind: 'projects', project_ids: ['prj_TEST0001'] },
  type: 'debugging_pattern',
  provenance: {
    source: 'agent_observed',
    verification: 'observed_once',
    evidence: [{ kind: 'commit', value: '9f2c1ab' }],
  },
  status: 'active',
  created_at: '2026-07-31T21:14:03Z',
  updated_at: '2026-07-31T21:14:03Z',
});

describe('resolveVerification', () => {
  test.each([
    ['user_stated', 'user_confirmed'],
    ['agent_observed', 'observed_once'],
    ['external_reference', 'source_confirmed'],
    ['inferred', 'unverified'],
  ] as const)('defaults %s to %s', (source, expected) => {
    expect(resolveVerification(source)).toBe(expected);
  });

  test('an explicit level wins over the default', () => {
    expect(resolveVerification('inferred', 'user_confirmed')).toBe('user_confirmed');
  });
});

describe('normalizeEvidence', () => {
  test('omits evidence entirely when none was supplied', () => {
    expect(normalizeEvidence(undefined)).toEqual({ dropped: [] });
  });

  test.each([
    ['a commit sha, lowercased', { kind: 'commit', value: '9F2C1AB' }, '9f2c1ab'],
    ['a forge pull request', { kind: 'pull_request', value: 'acme/relayer#412' }, undefined],
    [
      'a pull request URL',
      { kind: 'pull_request', value: 'https://github.com/acme/relayer/pull/412' },
      undefined,
    ],
    ['a tracker key, uppercased', { kind: 'issue', value: 'mem-123' }, 'MEM-123'],
    ['a forge issue reference', { kind: 'issue', value: 'acme/relayer#88' }, undefined],
    [
      'a URL with a pinned line fragment',
      { kind: 'url', value: 'https://github.com/o/r/blob/9f2c1ab/src/a.ts#L12-L30' },
      undefined,
    ],
    ['a repository-relative path', { kind: 'path', value: 'src/store/search.ts' }, undefined],
    [
      'a path with a redundant prefix',
      { kind: 'path', value: './src/store/search.ts' },
      'src/store/search.ts',
    ],
  ] as const)('keeps %s', (_label, entry, normalized) => {
    const result = normalizeEvidence([entry as EvidenceEntry]);
    expect(result.dropped).toEqual([]);
    expect(result.evidence?.[0]?.value).toBe(normalized ?? entry.value);
  });

  test.each([
    ['a branch name as a commit', { kind: 'commit', value: 'main' }],
    ['HEAD as a commit', { kind: 'commit', value: 'HEAD' }],
    ['a commit range', { kind: 'commit', value: '9f2c1ab..3e4d5c6' }],
    ['a bare number as a pull request', { kind: 'pull_request', value: '412' }],
    ['prose as an issue', { kind: 'issue', value: 'the onboarding ticket' }],
    ['a relative URL', { kind: 'url', value: '/docs/webhooks' }],
    ['a file:// URL', { kind: 'url', value: 'file:///Users/destiner/notes.md' }],
    ['a localhost URL', { kind: 'url', value: 'http://localhost:3000/webhooks' }],
    ['a .local URL', { kind: 'url', value: 'https://timur.local/dash' }],
    ['an absolute path', { kind: 'path', value: '/Users/destiner/code/memento/src/a.ts' }],
    ['a home-relative path', { kind: 'path', value: '~/code/memento/src/a.ts' }],
    ['a temp-directory path', { kind: 'path', value: '/var/folders/x/T/session.jsonl' }],
    ['a path with a line number', { kind: 'path', value: 'src/store/search.ts:42' }],
    ['a path with a line fragment', { kind: 'path', value: 'src/store/search.ts#L42' }],
    ['a traversing path', { kind: 'path', value: '../other-repo/src/a.ts' }],
    ['a build-output path', { kind: 'path', value: 'dist/store/search.js' }],
    ['a dependency path', { kind: 'path', value: 'node_modules/zod/index.js' }],
  ] as const)('drops %s, with a reason', (_label, entry) => {
    const result = normalizeEvidence([entry as EvidenceEntry]);
    expect(result.evidence).toBeUndefined();
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ kind: entry.kind, value: entry.value });
    expect(result.dropped[0]?.why).toBeTruthy();
  });

  test('keeps the good entries alongside the dropped ones', () => {
    const result = normalizeEvidence([
      { kind: 'commit', value: 'HEAD' },
      { kind: 'commit', value: '9f2c1ab' },
    ]);
    expect(result.evidence).toEqual([{ kind: 'commit', value: '9f2c1ab' }]);
    expect(result.dropped).toHaveLength(1);
  });

  test('preserves a note on a normalized entry', () => {
    const result = normalizeEvidence([
      { kind: 'commit', value: '9F2C1AB', note: 'introduced the key' },
    ]);
    expect(result.evidence).toEqual([
      { kind: 'commit', value: '9f2c1ab', note: 'introduced the key' },
    ]);
  });

  test('dedupes on kind and reference, keeping the first', () => {
    const result = normalizeEvidence([
      { kind: 'commit', value: '9f2c1ab', note: 'first' },
      { kind: 'commit', value: '9F2C1AB', note: 'second' },
    ]);
    expect(result.evidence).toEqual([{ kind: 'commit', value: '9f2c1ab', note: 'first' }]);
    expect(result.dropped).toEqual([]);
  });

  test('reports overflow past the cap rather than truncating silently', () => {
    const result = normalizeEvidence(commits(12));
    expect(result.evidence).toHaveLength(10);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]?.why).toContain('capped');
  });
});

describe('buildProvenance', () => {
  test('defaults verification and omits absent evidence', () => {
    const built = buildProvenance({ source: 'user_stated' });
    expect(built.provenance).toEqual({ source: 'user_stated', verification: 'user_confirmed' });
    expect(built.provenance.evidence).toBeUndefined();
    expect(built.dropped).toEqual([]);
  });

  test('reports dropped evidence without failing the build', () => {
    const built = buildProvenance({
      source: 'agent_observed',
      evidence: [{ kind: 'commit', value: 'HEAD' }],
    });
    expect(built.provenance).toEqual({ source: 'agent_observed', verification: 'observed_once' });
    expect(built.dropped).toHaveLength(1);
  });
});

describe('mergeProvenance', () => {
  const existing: MemoryProvenance = {
    source: 'agent_observed',
    verification: 'observed_once',
    evidence: [{ kind: 'commit', value: '9f2c1ab' }],
  };

  test('returns a copy when there is no patch', () => {
    const merged = mergeProvenance(existing, undefined);
    expect(merged.provenance).toEqual(existing);
    expect(merged.provenance.evidence).not.toBe(existing.evidence);
  });

  test('a source change does not re-derive verification', () => {
    const merged = mergeProvenance(existing, { source: 'inferred' });
    expect(merged.provenance).toMatchObject({ source: 'inferred', verification: 'observed_once' });
  });

  test('an explicit verification moves it', () => {
    const merged = mergeProvenance(existing, { verification: 'user_confirmed' });
    expect(merged.provenance.verification).toBe('user_confirmed');
  });

  test('appends and dedupes evidence by default', () => {
    const merged = mergeProvenance(existing, {
      evidence: [
        { kind: 'commit', value: '9F2C1AB' },
        { kind: 'issue', value: 'MEM-12' },
      ],
    });
    expect(merged.provenance.evidence).toEqual([
      { kind: 'commit', value: '9f2c1ab' },
      { kind: 'issue', value: 'MEM-12' },
    ]);
  });

  test('replaces evidence when asked', () => {
    const merged = mergeProvenance(
      existing,
      { evidence: [{ kind: 'issue', value: 'MEM-12' }] },
      true,
    );
    expect(merged.provenance.evidence).toEqual([{ kind: 'issue', value: 'MEM-12' }]);
  });

  test('carries hand-written evidence through unexamined', () => {
    const handEdited: MemoryProvenance = {
      source: 'user_stated',
      verification: 'user_confirmed',
      evidence: [{ kind: 'commit', value: 'HEAD' }],
    };
    const untouched = mergeProvenance(handEdited, { verification: 'source_confirmed' });
    expect(untouched.provenance.evidence).toEqual([{ kind: 'commit', value: 'HEAD' }]);
    expect(untouched.dropped).toEqual([]);

    const appended = mergeProvenance(handEdited, {
      evidence: [{ kind: 'commit', value: '9f2c1ab' }],
    });
    expect(appended.provenance.evidence).toEqual([
      { kind: 'commit', value: 'HEAD' },
      { kind: 'commit', value: '9f2c1ab' },
    ]);
    expect(appended.dropped).toEqual([]);
  });

  test('reports overflow when a merge exceeds the cap', () => {
    const full: MemoryProvenance = {
      source: 'agent_observed',
      verification: 'observed_once',
      evidence: commits(10),
    };
    const merged = mergeProvenance(full, { evidence: [{ kind: 'issue', value: 'MEM-12' }] });
    expect(merged.provenance.evidence).toHaveLength(10);
    expect(merged.dropped).toEqual([
      { kind: 'issue', value: 'MEM-12', why: 'evidence is capped at 10 entries' },
    ]);
  });
});

describe('mergeScope', () => {
  const projects: MemoryScope = { kind: 'projects', project_ids: ['prj_A'] };

  test('copies the existing scope when nothing is supplied', () => {
    expect(mergeScope(projects, undefined)).toEqual(projects);
    expect(mergeScope({ kind: 'global' }, undefined)).toEqual({ kind: 'global' });
  });

  test('appends and dedupes project ids by default', () => {
    expect(mergeScope(projects, { kind: 'projects', project_ids: ['prj_B', 'prj_A'] })).toEqual({
      kind: 'projects',
      project_ids: ['prj_A', 'prj_B'],
    });
  });

  test('replaces project ids when asked', () => {
    expect(mergeScope(projects, { kind: 'projects', project_ids: ['prj_B'] }, true)).toEqual({
      kind: 'projects',
      project_ids: ['prj_B'],
    });
  });

  test('switching to global discards the project ids', () => {
    expect(mergeScope(projects, { kind: 'global' })).toEqual({ kind: 'global' });
  });

  test('switching from global takes only the incoming ids', () => {
    expect(mergeScope({ kind: 'global' }, { kind: 'projects', project_ids: ['prj_B'] })).toEqual({
      kind: 'projects',
      project_ids: ['prj_B'],
    });
  });
});

describe('orderMemoryMetadata', () => {
  test('emits the canonical field order', () => {
    expect(Object.keys(orderMemoryMetadata(record))).toEqual([
      'id',
      'title',
      'description',
      'scope',
      'type',
      'provenance',
      'status',
      'created_at',
      'updated_at',
    ]);
  });

  test('appends the optional lifecycle fields when present', () => {
    const archived = validateMemoryFrontmatter({
      ...record,
      status: 'archived',
      archive_reason: 'vendor fixed the retry',
      last_verified_at: '2026-08-04T09:02:11Z',
    });
    expect(Object.keys(orderMemoryMetadata(archived)).slice(-2)).toEqual([
      'last_verified_at',
      'archive_reason',
    ]);
  });

  test('orders the nested scope and provenance too', () => {
    const ordered = orderMemoryMetadata(record);
    expect(Object.keys(ordered.scope as object)).toEqual(['kind', 'project_ids']);
    expect(Object.keys(ordered.provenance as object)).toEqual([
      'source',
      'verification',
      'evidence',
    ]);
  });

  test('omits an empty evidence list', () => {
    const bare = validateMemoryFrontmatter({
      ...record,
      provenance: { source: 'user_stated', verification: 'user_confirmed' },
    });
    expect(orderMemoryMetadata(bare).provenance).toEqual({
      source: 'user_stated',
      verification: 'user_confirmed',
    });
  });

  test('round-trips through validation', () => {
    expect(() => validateMemoryFrontmatter(orderMemoryMetadata(record))).not.toThrow();
  });
});

function commits(count: number): EvidenceEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'commit' as const,
    value: `9f2c1a${index.toString().padStart(2, '0')}`,
  }));
}
