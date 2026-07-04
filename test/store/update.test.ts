import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { createMemory } from '../../src/store/create.js';
import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { updateMemory } from '../../src/store/update.js';

const T1 = Date.parse('2026-07-04T14:20:00Z');
const T2 = Date.parse('2026-08-01T09:00:00Z');

const seedInput = {
  title: 'ExampleEmailVendor: deliverability caveat',
  type: 'integration',
  scope: 'cross_project',
  body: '## Summary\nWebhooks lag at peak volume.',
};

describe('updateMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-update-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(overrides: Record<string, unknown> = {}, id = 'mem_UPD00001') {
    return createMemory(
      { ...seedInput, ...overrides },
      { memoriesDir: dir, now: T1, makeId: () => id },
    );
  }

  test('applies metadata changes, bumps updated_at, preserves created_at', async () => {
    const { path } = await seed();

    const result = await updateMemory(
      { id: 'mem_UPD00001', changes: { confidence: 'high', status: 'needs_review' } },
      { memoriesDir: dir, now: T2 },
    );

    expect(result).toEqual({ id: 'mem_UPD00001', path, updated: true });
    const { metadata, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    expect(metadata.confidence).toBe('high');
    expect(metadata.status).toBe('needs_review');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.updated_at).toBe('2026-08-01T09:00:00Z');
    expect(body).toBe('## Summary\nWebhooks lag at peak volume.');
  });

  test('edits the body via an exact old_text/new_text match', async () => {
    const { path } = await seed();

    await updateMemory(
      { id: 'mem_UPD00001', old_text: 'lag at peak volume', new_text: 'lag during peak load' },
      { memoriesDir: dir, now: T2 },
    );

    const { body } = parseFrontmatter(readFileSync(path, 'utf8'));
    expect(body).toBe('## Summary\nWebhooks lag during peak load.');
  });

  test('replaces the whole body', async () => {
    const { path } = await seed();

    await updateMemory(
      { id: 'mem_UPD00001', body: '## Summary\nRewritten entirely.' },
      { memoriesDir: dir, now: T2 },
    );

    const { body } = parseFrontmatter(readFileSync(path, 'utf8'));
    expect(body).toBe('## Summary\nRewritten entirely.');
  });

  test('rejects old_text that is not found, leaving the file untouched', async () => {
    const { path } = await seed();
    const before = readFileSync(path, 'utf8');

    await expect(
      updateMemory(
        { id: 'mem_UPD00001', old_text: 'not present', new_text: 'x' },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('rejects old_text that matches more than once', async () => {
    await seed({ body: '## Summary\nfoo and foo again.' });

    await expect(
      updateMemory(
        { id: 'mem_UPD00001', old_text: 'foo', new_text: 'bar' },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('rejects body and old_text supplied together', async () => {
    await seed();
    await expect(
      updateMemory(
        { id: 'mem_UPD00001', body: 'x', old_text: 'y', new_text: 'z' },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toBeInstanceOf(MementoError);
  });

  test('rejects an update with no operation', async () => {
    await seed();
    await expect(
      updateMemory({ id: 'mem_UPD00001' }, { memoriesDir: dir, now: T2 }),
    ).rejects.toBeInstanceOf(MementoError);
  });

  test('rejects changes to system fields', async () => {
    await seed();
    await expect(
      updateMemory(
        { id: 'mem_UPD00001', changes: { created_at: '2000-01-01T00:00:00Z' } },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toBeInstanceOf(MementoError);
  });

  test('rejects an out-of-vocabulary status change', async () => {
    await seed();
    await expect(
      updateMemory(
        { id: 'mem_UPD00001', changes: { status: 'nonsense' } },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toBeInstanceOf(MementoError);
  });

  test('renames the file when the title changes', async () => {
    await seed({ title: 'Old title' });

    const result = await updateMemory(
      { id: 'mem_UPD00001', changes: { title: 'New shiny title' } },
      { memoriesDir: dir, now: T2 },
    );

    expect(result.path).toBe(join(dir, 'mem_UPD00001-new-shiny-title.md'));
    expect(readdirSync(dir)).toEqual(['mem_UPD00001-new-shiny-title.md']);
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));
    expect(metadata.title).toBe('New shiny title');
  });

  test('throws not_found for an unknown id', async () => {
    await expect(
      updateMemory(
        { id: 'mem_MISSING', changes: { status: 'archived' } },
        { memoriesDir: dir, now: T2 },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
