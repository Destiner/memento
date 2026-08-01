import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { archiveMemory } from '../../src/store/memory-archive.js';
import { createMemory, MemoryCreatedIndexError } from '../../src/store/memory-create.js';
import { validateMemoryFrontmatter } from '../../src/store/memory-schema.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { createInput, PROJECT_A, PROJECT_B, seedProjects } from '../helpers/memories.js';
import { createdMemory, gatedMemory } from '../helpers/outcomes.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/memories');

const FIXED_NOW = Date.parse('2026-07-04T14:20:00Z');

describe('createMemory', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-create-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    await seedProjects(projectsDir);
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  function options(overrides: Record<string, unknown> = {}) {
    return { memoriesDir, projectsDir, index, ...overrides };
  }

  // The directory is created by the first write, so "nothing was written" is
  // either an absent directory or an empty one.
  function memoryFiles(): string[] {
    return existsSync(memoriesDir) ? readdirSync(memoriesDir) : [];
  }

  test('writes a canonical file and returns its identity and summary', async () => {
    const result = createdMemory(
      await createMemory(createInput(), options({ now: FIXED_NOW, makeId: () => 'mem_TEST0001' })),
    );

    expect(result.id).toBe('mem_TEST0001');
    expect(result.path).toBe(
      join(memoriesDir, 'mem_TEST0001-webhook-retries-duplicate-sends-under-load.md'),
    );
    expect(result.memory).toEqual({
      id: 'mem_TEST0001',
      title: 'Webhook retries duplicate sends under load',
      description: 'The provider delays webhooks at peak volume, so retries look like duplicates.',
      scope: { kind: 'projects', project_ids: [PROJECT_A] },
      type: 'debugging_pattern',
      status: 'active',
      updated_at: '2026-07-04T14:20:00Z',
    });
    expect(result.dropped_evidence).toEqual([]);
  });

  test('rebuilds the derived index after a post-write indexing failure', async () => {
    vi.spyOn(index, 'upsert').mockImplementationOnce(() => {
      throw new Error('transient index failure');
    });

    const result = createdMemory(
      await createMemory(createInput(), options({ makeId: () => 'mem_REPAIRED1' })),
    );

    expect(result.id).toBe('mem_REPAIRED1');
    expect(memoryFiles()).toHaveLength(1);
    expect(index.count()).toBe(1);
  });

  test('reports that the durable file exists when index repair also fails', async () => {
    vi.spyOn(index, 'upsert').mockImplementation(() => {
      throw new Error('persistent index failure');
    });

    await expect(
      createMemory(createInput(), options({ makeId: () => 'mem_UNCERTAIN1' })),
    ).rejects.toMatchObject({
      name: 'MemoryCreatedIndexError',
      memoryId: 'mem_UNCERTAIN1',
    } satisfies Partial<MemoryCreatedIndexError>);
    expect(memoryFiles()).toHaveLength(1);
  });

  test('sets lifecycle fields and defaults verification from source', async () => {
    const result = createdMemory(
      await createMemory(createInput(), options({ now: FIXED_NOW, makeId: () => 'mem_TEST0002' })),
    );
    const { metadata, body } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(metadata.id).toBe('mem_TEST0002');
    expect(metadata.status).toBe('active');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.updated_at).toBe('2026-07-04T14:20:00Z');
    // agent_observed -> observed_once (docs/memory-policy.md §9).
    expect(metadata.provenance).toEqual({
      source: 'agent_observed',
      verification: 'observed_once',
    });
    expect(metadata).not.toHaveProperty('last_verified_at');
    expect(metadata).not.toHaveProperty('archive_reason');
    expect(body).toBe('Preserve idempotency keys; webhook arrival time is not a freshness signal.');
  });

  test('produces a record that re-validates against the schema', async () => {
    const result = createdMemory(
      await createMemory(
        createInput({
          scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
          provenance: {
            source: 'external_reference',
            evidence: [{ kind: 'url', value: 'https://example.com/docs', note: 'vendor docs' }],
          },
        }),
        options({ makeId: () => 'mem_TEST0003' }),
      ),
    );
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(() => validateMemoryFrontmatter(metadata)).not.toThrow();
  });

  // Item 10: single-project, multi-project, and global are all first-class.
  test('stores a multi-project memory', async () => {
    const result = createdMemory(
      await createMemory(
        createInput({ scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] } }),
        options({ makeId: () => 'mem_MULTI001' }),
      ),
    );

    expect(result.memory.scope).toEqual({
      kind: 'projects',
      project_ids: [PROJECT_A, PROJECT_B],
    });
  });

  test('stores a global memory with no project ids', async () => {
    const result = createdMemory(
      await createMemory(
        createInput({
          title: 'Conventional commits, minimal bodies',
          description: 'The user wants conventional commit subjects and short bodies.',
          type: 'preference',
          scope: { kind: 'global' },
          provenance: { source: 'user_stated' },
        }),
        options({ makeId: () => 'mem_GLOBAL01' }),
      ),
    );

    expect(result.memory.scope).toEqual({ kind: 'global' });
  });

  test('rejects a project id no project answers to, without writing', async () => {
    await expect(
      createMemory(
        createInput({ scope: { kind: 'projects', project_ids: ['prj_NOTREGISTERED'] } }),
        options(),
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { unknown_ids: ['prj_NOTREGISTERED'] },
    });
    expect(memoryFiles()).toEqual([]);
  });

  test('reports dropped evidence without failing the write', async () => {
    const result = createdMemory(
      await createMemory(
        createInput({
          provenance: {
            source: 'agent_observed',
            evidence: [
              { kind: 'commit', value: 'main' },
              { kind: 'path', value: 'src/store/search-index.ts' },
            ],
          },
        }),
        options({ makeId: () => 'mem_EVID0001' }),
      ),
    );

    expect(result.dropped_evidence).toEqual([
      {
        kind: 'commit',
        value: 'main',
        why: 'not a commit sha (expected 7-40 hexadecimal characters)',
      },
    ]);
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));
    expect(metadata.provenance).toMatchObject({
      evidence: [{ kind: 'path', value: 'src/store/search-index.ts' }],
    });
  });

  describe('dedupe gate', () => {
    async function seedExisting(): Promise<void> {
      await createMemory(createInput(), options({ makeId: () => 'mem_EXISTING1' }));
    }

    test('returns candidates instead of writing a near-duplicate', async () => {
      await seedExisting();

      const result = gatedMemory(
        await createMemory(
          createInput({
            title: 'Duplicate sends come from webhook retries under load',
            description: 'Retries look like duplicate sends because the provider delays webhooks.',
          }),
          options(),
        ),
      );

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ id: 'mem_EXISTING1', status: 'active' });
      expect(result.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.55);
      expect(memoryFiles()).toHaveLength(1);
    });

    test('force_create with a reason proceeds', async () => {
      await seedExisting();

      const result = createdMemory(
        await createMemory(
          createInput({
            force_create: true,
            force_create_reason: 'Same symptom, different root cause worth its own memory.',
          }),
          options({ makeId: () => 'mem_FORCED001' }),
        ),
      );

      expect(result.id).toBe('mem_FORCED001');
      expect(memoryFiles()).toHaveLength(2);
    });

    test('force_create without a reason is rejected', async () => {
      await seedExisting();

      await expect(
        createMemory(createInput({ force_create: true }), options()),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    // The gate is same-scope: one project's insight is not another's duplicate.
    test('does not gate across scopes', async () => {
      await seedExisting();

      const otherProject = await createMemory(
        createInput({ scope: { kind: 'projects', project_ids: [PROJECT_B] } }),
        options({ makeId: () => 'mem_OTHERPRJ' }),
      );
      const global = await createMemory(
        createInput({ scope: { kind: 'global' } }),
        options({ makeId: () => 'mem_GLOBAL02' }),
      );

      expect(otherProject.outcome).toBe('created');
      expect(global.outcome).toBe('created');
    });

    test('leaves an unrelated memory alone', async () => {
      await seedExisting();

      const result = await createMemory(
        createInput({
          title: 'Delayed dashboard pricing is a contract term',
          description: 'The real-time feed is contractually restricted to internal users.',
          type: 'product_rationale',
        }),
        options({ makeId: () => 'mem_UNRELATED' }),
      );

      expect(result.outcome).toBe('created');
    });

    test('offers an archived near-duplicate so it can be restored instead', async () => {
      const seeded = createdMemory(
        await createMemory(createInput(), options({ makeId: () => 'mem_ARCHIVED1' })),
      );
      await archiveMemory(
        { id: seeded.id, reason: 'Superseded once the vendor fixed delivery.' },
        { memoriesDir, index },
      );

      const result = gatedMemory(await createMemory(createInput(), options()));
      expect(result.candidates[0]).toMatchObject({ id: 'mem_ARCHIVED1', status: 'archived' });
    });
  });

  describe('input validation', () => {
    test('rejects an out-of-vocabulary type without writing a file', async () => {
      await expect(
        createMemory(createInput({ type: 'nonsense' }), options()),
      ).rejects.toBeInstanceOf(MementoError);
      expect(memoryFiles()).toEqual([]);
    });

    test('rejects input missing a required field', async () => {
      const input = createInput();
      delete input.description;
      await expect(createMemory(input, options())).rejects.toBeInstanceOf(MementoError);
    });

    test('rejects server-managed fields', async () => {
      await expect(
        createMemory(createInput({ status: 'archived' }), options()),
      ).rejects.toBeInstanceOf(MementoError);
      await expect(createMemory(createInput({ id: 'mem_HAND' }), options())).rejects.toBeInstanceOf(
        MementoError,
      );
    });

    test('rejects a projects scope with no project ids', async () => {
      await expect(
        createMemory(createInput({ scope: { kind: 'projects', project_ids: [] } }), options()),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    test('rejects a global scope carrying project ids', async () => {
      await expect(
        createMemory(
          createInput({ scope: { kind: 'global', project_ids: [PROJECT_A] } }),
          options(),
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
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
    expect(() => validateMemoryFrontmatter(metadata)).not.toThrow();
    expect(body.length).toBeGreaterThan(0);
    expect(file).toContain(String(metadata.id));
  });
});
