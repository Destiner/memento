import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { createMemory } from '../../src/store/create.js';
import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { validateFrontmatter } from '../../src/store/schema.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/memories');

const FIXED_NOW = Date.parse('2026-07-04T14:20:00Z');

const validInput = {
  title: 'ExampleEmailVendor: deliverability caveat',
  type: 'integration',
  scope: 'cross_project',
  body: '## Summary\nWebhooks lag at peak volume.',
};

describe('createMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-create-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes a canonical file and returns its identity', async () => {
    const result = await createMemory(validInput, {
      memoriesDir: dir,
      now: FIXED_NOW,
      makeId: () => 'mem_TEST0001',
    });

    expect(result).toEqual({
      id: 'mem_TEST0001',
      path: join(dir, 'mem_TEST0001-exampleemailvendor-deliverability-caveat.md'),
      created: true,
    });
    expect(readdirSync(dir)).toEqual(['mem_TEST0001-exampleemailvendor-deliverability-caveat.md']);
  });

  test('sets server-managed lifecycle fields', async () => {
    const result = await createMemory(validInput, {
      memoriesDir: dir,
      now: FIXED_NOW,
      makeId: () => 'mem_TEST0002',
    });
    const { metadata, body } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(metadata.id).toBe('mem_TEST0002');
    expect(metadata.status).toBe('active');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.updated_at).toBe('2026-07-04T14:20:00Z');
    expect(body).toBe('## Summary\nWebhooks lag at peak volume.');
  });

  test('persists supplied optional fields and omits unsupplied ones', async () => {
    const result = await createMemory(
      { ...validInput, tags: ['deliverability'], confidence: 'medium' },
      { memoriesDir: dir, makeId: () => 'mem_TEST0003' },
    );
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(metadata.tags).toEqual(['deliverability']);
    expect(metadata.confidence).toBe('medium');
    expect(metadata).not.toHaveProperty('projects');
    expect(metadata).not.toHaveProperty('importance');
  });

  test('produces a record that re-validates against the schema', async () => {
    const result = await createMemory(
      { ...validInput, projects: ['marketing-api'], importance: 'high' },
      { memoriesDir: dir, makeId: () => 'mem_TEST0004' },
    );
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));
    expect(() => validateFrontmatter(metadata)).not.toThrow();
  });

  test('gives concurrent creates distinct ids and files', async () => {
    let counter = 0;
    const opts = { memoriesDir: dir, now: FIXED_NOW, makeId: () => `mem_SEQ${counter++}` };
    await Promise.all([
      createMemory(validInput, opts),
      createMemory(validInput, opts),
      createMemory(validInput, opts),
    ]);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  test('rejects an out-of-vocabulary type without writing a file', async () => {
    await expect(
      createMemory({ ...validInput, type: 'nonsense' }, { memoriesDir: dir }),
    ).rejects.toBeInstanceOf(MementoError);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('rejects input missing a required field', async () => {
    const noBody = { title: validInput.title, type: validInput.type, scope: validInput.scope };
    await expect(createMemory(noBody, { memoriesDir: dir })).rejects.toBeInstanceOf(MementoError);
  });

  test('rejects unknown input keys', async () => {
    await expect(
      createMemory({ ...validInput, status: 'archived' }, { memoriesDir: dir }),
    ).rejects.toBeInstanceOf(MementoError);
  });
});

describe('fixture memories', () => {
  const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.md'));

  test('at least a few fixtures exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  test.each(files)('%s parses and validates as a canonical record', (file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), 'utf8');
    const { metadata, body } = parseFrontmatter(raw);
    expect(() => validateFrontmatter(metadata)).not.toThrow();
    expect(body.length).toBeGreaterThan(0);
    expect(file).toContain(String(metadata.id));
  });
});
