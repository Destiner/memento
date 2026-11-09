import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { decayMemories } from '../../src/store/memory-decay.js';
import { getMemory, readMemory } from '../../src/store/memory-get.js';
import { withMemoryMutationLock } from '../../src/store/memory-mutation-lock.js';
import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { updateMemory } from '../../src/store/memory-update.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord } from '../helpers/memories.js';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const iso = (day: number) => new Date(START + day * DAY).toISOString().replace('.000Z', 'Z');
const ID = 'mem_TEST0000';

describe('durable memory decay lifecycle', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;
  const config = { memory_archive_after_days: 90, memory_delete_after_days: 90 };
  const options = (day: number) => ({ memoriesDir, projectsDir, index, now: START + day * DAY });
  const decay = (day: number) => decayMemories({ ...options(day), config });
  const inspect = () => readMemory({ id: ID }, { memoriesDir, projectsDir });
  const read = (day: number) => getMemory({ id: ID }, options(day));
  const path = () => join(memoriesDir, 'memory.md');
  function seed(overrides: Partial<MemoryRecord> = {}) {
    const record = memoryRecord({
      ...(overrides.status === 'archived' ? { archive_reason: 'Retention test archive' } : {}),
      scope: { kind: 'global' },
      created_at: iso(0),
      updated_at: iso(0),
      ...overrides,
    });
    writeFileSync(path(), serializeFrontmatter(record, 'Webhook retention body.'));
    index.upsert(record, 'Webhook retention body.');
  }
  function hits(status: 'active' | 'archived') {
    return index.search('webhook', { scope: { kind: 'global' }, status: [status], limit: 10 });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memento-decay-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    mkdirSync(memoriesDir);
    index = new MemoryIndex(join(home, 'index.sqlite'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('never-read memories archive at exactly 90 days from creation, not updated_at', async () => {
    seed({ updated_at: iso(89) });
    expect(await decay(90 - 1 / DAY)).toMatchObject({ archived: 0, deleted: 0 });
    expect(await decay(90)).toEqual({ archived: 1, deleted: 0, initialized: 0, skipped: [] });
    expect(await inspect()).toMatchObject({
      status: 'archived',
      archive_source: 'decay',
      archived_at: iso(90),
    });
    expect(hits('active')).toHaveLength(0);
    expect(hits('archived')).toHaveLength(1);
  });

  test('explicit reads postpone archive without changing updated_at', async () => {
    seed();
    expect(await read(89)).toMatchObject({ last_accessed_at: iso(89), updated_at: iso(0) });
    expect((await decay(90)).archived).toBe(0);
    expect((await decay(179 - 1 / DAY)).archived).toBe(0);
    expect((await decay(179)).archived).toBe(1);
  });

  test('reading an automatic archive restores it and removes all archive metadata from disk and index', async () => {
    seed();
    await decay(90);
    const restored = await read(100);
    expect(restored).toMatchObject({
      status: 'active',
      last_accessed_at: iso(100),
      updated_at: iso(100),
    });
    for (const field of ['archive_reason', 'archive_source', 'archived_at']) {
      expect(restored).not.toHaveProperty(field);
      expect(await inspect()).not.toHaveProperty(field);
    }
    expect(hits('active')).toHaveLength(1);
    expect(hits('archived')).toHaveLength(0);
    expect((await decay(189)).archived).toBe(0);
    expect((await decay(190)).archived).toBe(1);
  });

  test('manual archive reads preserve archive state and reset the deletion grace', async () => {
    seed({
      status: 'archived',
      archive_source: 'manual',
      archive_reason: 'Superseded',
      archived_at: iso(0),
    });
    expect(await read(89)).toMatchObject({
      status: 'archived',
      archive_source: 'manual',
      archive_reason: 'Superseded',
      archived_at: iso(0),
      last_accessed_at: iso(89),
      updated_at: iso(0),
    });
    expect((await decay(90)).deleted).toBe(0);
    expect((await decay(179 - 1 / DAY)).deleted).toBe(0);
    expect((await decay(179)).deleted).toBe(1);
  });

  test.each(['sweep', 'read'] as const)(
    'legacy archive gets a full grace period on first %s',
    async (operation) => {
      seed({ status: 'archived', updated_at: iso(1) });
      if (operation === 'sweep') expect((await decay(500)).initialized).toBe(1);
      else await read(500);
      expect(await inspect()).toMatchObject({
        status: 'archived',
        archived_at: iso(500),
        updated_at: iso(1),
      });
      expect((await decay(589)).deleted).toBe(0);
      expect((await decay(590)).deleted).toBe(1);
    },
  );

  test('long downtime never archives and deletes in the same sweep; deletion survives rebuild', async () => {
    seed();
    expect(await decay(1000)).toMatchObject({ archived: 1, deleted: 0 });
    expect(await inspect()).toMatchObject({ archived_at: iso(1000) });
    expect((await decay(1000)).deleted).toBe(0);
    expect((await decay(1090 - 1 / DAY)).deleted).toBe(0);
    expect((await decay(1090)).deleted).toBe(1);
    expect(existsSync(path())).toBe(false);
    expect(hits('archived')).toHaveLength(0);
    await rebuildIndex(index, memoriesDir);
    expect(hits('archived')).toHaveLength(0);
    await expect(inspect()).rejects.toMatchObject({ code: 'not_found' });
  });

  test('search, internal inspection and ordinary updates do not reset access timers', async () => {
    seed({ last_accessed_at: iso(2) });
    const original = readFileSync(path(), 'utf8');
    hits('active');
    await inspect();
    expect(readFileSync(path(), 'utf8')).toBe(original);
    await updateMemory({ id: ID, body: 'Updated webhook retention body.' }, options(89));
    expect(await inspect()).toMatchObject({ last_accessed_at: iso(2), updated_at: iso(89) });
    expect((await decay(92)).archived).toBe(1);
  });

  test('timestamps survive index reopen and complete rebuild, including renamed memory files', async () => {
    seed();
    renameSync(path(), join(memoriesDir, 'human-renamed.md'));
    await read(30);
    index.close();
    index = new MemoryIndex(join(home, 'index.sqlite'));
    await rebuildIndex(index, memoriesDir);
    expect(await inspect()).toMatchObject({ last_accessed_at: iso(30), updated_at: iso(0) });
    expect((await decay(119)).archived).toBe(0);
    await decay(120);
    index.close();
    index = new MemoryIndex();
    await rebuildIndex(index, memoriesDir);
    expect(await inspect()).toMatchObject({ archived_at: iso(120), last_accessed_at: iso(30) });
    expect((await decay(209)).deleted).toBe(0);
    expect((await decay(210)).deleted).toBe(1);
    expect(existsSync(join(memoriesDir, 'human-renamed.md'))).toBe(false);
  });

  test('malformed records, symlinks and duplicate ids are skipped without destructive guesses', async () => {
    seed();
    const original = readFileSync(path(), 'utf8');
    writeFileSync(join(memoriesDir, 'duplicate.md'), original);
    writeFileSync(join(memoriesDir, 'broken.md'), '---\nstatus: nonsense\n---\nbody');
    const outside = join(home, 'outside.md');
    writeFileSync(outside, original);
    symlinkSync(outside, join(memoriesDir, 'link.md'));
    symlinkSync(path(), join(memoriesDir, 'internal-link.md'));
    const result = await decay(1000);
    expect(result).toMatchObject({ archived: 0, deleted: 0, initialized: 0 });
    expect(result.skipped.map(({ file }) => file).sort()).toEqual([
      'broken.md',
      'duplicate.md',
      'internal-link.md',
      'link.md',
      'memory.md',
    ]);
    expect(result.skipped.every(({ reason }) => reason.length > 0)).toBe(true);
    expect(readFileSync(path(), 'utf8')).toBe(original);
    expect(readFileSync(outside, 'utf8')).toBe(original);
    expect(readFileSync(join(memoriesDir, 'duplicate.md'), 'utf8')).toBe(original);
  });

  test('empty or absent stores are harmless', async () => {
    expect(await decay(90)).toEqual({ archived: 0, deleted: 0, initialized: 0, skipped: [] });
    rmSync(memoriesDir, { recursive: true });
    expect(await decay(90)).toEqual({ archived: 0, deleted: 0, initialized: 0, skipped: [] });
  });

  test('read and decay honor the same mutation lock rather than losing a concurrent mutation', async () => {
    seed();
    await withMemoryMutationLock(memoriesDir, async () => {
      const results = await Promise.allSettled([read(90), decay(90)]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'invalid_request' });
      }
    });
    expect(await inspect()).toMatchObject({ status: 'active', updated_at: iso(0) });
    expect(await inspect()).not.toHaveProperty('last_accessed_at');
    await read(90);
    expect((await decay(90)).archived).toBe(0);
  });

  test('index upsert failure after archival recovers from durable markdown', async () => {
    seed();
    vi.spyOn(index, 'upsert').mockImplementationOnce(() => {
      throw new Error('injected index failure');
    });
    expect((await decay(90)).archived).toBe(1);
    expect(hits('archived')).toHaveLength(1);
    expect(await inspect()).toMatchObject({ archived_at: iso(90) });
  });

  test('index remove failure recovers before deleting the authoritative file', async () => {
    seed({ status: 'archived', archived_at: iso(0), archive_source: 'manual' });
    vi.spyOn(index, 'remove').mockImplementationOnce(() => {
      throw new Error('injected index failure');
    });
    expect((await decay(90)).deleted).toBe(1);
    expect(existsSync(path())).toBe(false);
    expect(hits('archived')).toHaveLength(0);
  });

  test('failed index cleanup preserves the file so a later sweep can retry deletion', async () => {
    seed({ status: 'archived', archived_at: iso(0), archive_source: 'manual' });
    const remove = vi.spyOn(index, 'remove').mockImplementation(() => {
      throw new Error('remove failed');
    });
    const clear = vi.spyOn(index, 'clear').mockImplementation(() => {
      throw new Error('rebuild failed');
    });
    await expect(decay(90)).rejects.toThrow('rebuild failed');
    expect(existsSync(path())).toBe(true);
    remove.mockRestore();
    clear.mockRestore();
    expect((await decay(91)).deleted).toBe(1);
    expect(existsSync(path())).toBe(false);
    expect(hits('archived')).toHaveLength(0);
  });

  test('failed indexing never reports a completed transition; the next sweep repairs it', async () => {
    seed();
    const upsert = vi.spyOn(index, 'upsert').mockImplementation(() => {
      throw new Error('index failed');
    });
    await expect(decay(90)).rejects.toThrow('index failed');
    expect(await inspect()).toMatchObject({ status: 'archived', archived_at: iso(90) });
    upsert.mockRestore();
    expect((await decay(91)).archived).toBe(0);
    expect(hits('active')).toHaveLength(0);
    expect(hits('archived')).toHaveLength(1);
  });

  test('maintenance reconciles interrupted archive and restore index transitions', async () => {
    seed();
    await decay(90);
    index.upsert(memoryRecord({ scope: { kind: 'global' } }), 'Webhook retention body.');
    expect(hits('active')).toHaveLength(1);
    await decay(91);
    expect(hits('active')).toHaveLength(0);
    expect(hits('archived')).toHaveLength(1);
    const archived = await inspect();
    await read(92);
    index.upsert(archived, archived.body);
    await decay(93);
    expect(hits('active')).toHaveLength(1);
    expect(hits('archived')).toHaveLength(0);
  });

  test.each([0, -1, 0.5, NaN, Infinity, 365001, undefined])(
    'refuses unsafe retention %s before mutating',
    async (days) => {
      seed();
      for (const key of ['memory_archive_after_days', 'memory_delete_after_days'] as const) {
        await expect(
          decayMemories({ ...options(1000), config: { ...config, [key]: days } }),
        ).rejects.toThrow(key);
      }
      expect(await inspect()).toMatchObject({ status: 'active' });
    },
  );

  test('read index failure recovers both the access timestamp and automatic restoration', async () => {
    seed({ status: 'archived', archived_at: iso(0), archive_source: 'decay' });
    vi.spyOn(index, 'upsert').mockImplementationOnce(() => {
      throw new Error('injected index failure');
    });
    expect(await read(10)).toMatchObject({ status: 'active', last_accessed_at: iso(10) });
    expect(hits('active')).toHaveLength(1);
    expect(hits('archived')).toHaveLength(0);
    expect(await inspect()).toMatchObject({ last_accessed_at: iso(10) });
  });
});
