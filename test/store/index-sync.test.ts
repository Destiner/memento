import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { archiveMemory } from '../../src/store/memory-archive.js';
import { createMemory } from '../../src/store/memory-create.js';
import { updateMemory } from '../../src/store/memory-update.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { createInput, PROJECT_A, seedProjects } from '../helpers/memories.js';

const SCOPE = { kind: 'projects' as const, project_ids: [PROJECT_A] };

// The description deliberately avoids the terms the body tests edit, so a
// re-index assertion is about the field it names. Description is indexed too.
const input = createInput({
  title: 'Billing service map',
  description: 'How billing depends on the customer portal at checkout.',
  type: 'cross_project_context',
  body: 'The billing service calls the customer portal over gRPC.',
});

describe('incremental index sync', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-sync-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    await seedProjects(projectsDir, [PROJECT_A]);
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  function opts(overrides: Record<string, unknown> = {}) {
    return { memoriesDir, projectsDir, index, ...overrides };
  }

  // Mirrors the operation's default: search_memories asks for active only.
  const search = (query: string, status: ('active' | 'archived')[] = ['active']) =>
    index.search(query, { limit: 5, scope: SCOPE, status });

  test('create_memory makes a memory searchable immediately', async () => {
    await createMemory(input, opts({ makeId: () => 'mem_SYNC0001' }));

    const hits = search('billing grpc');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('mem_SYNC0001');
  });

  test('update_memory re-indexes the edited body in place', async () => {
    await createMemory(input, opts({ makeId: () => 'mem_SYNC0002' }));
    await updateMemory(
      { id: 'mem_SYNC0002', old_text: 'over gRPC', new_text: 'over a REST webhook' },
      opts(),
    );

    expect(index.count()).toBe(1);
    expect(search('webhook')).toHaveLength(1);
    expect(search('grpc')).toHaveLength(0);
  });

  test('update_memory re-indexes changed metadata', async () => {
    await createMemory(input, opts({ makeId: () => 'mem_SYNC0003' }));
    await updateMemory(
      { id: 'mem_SYNC0003', changes: { description: 'Onboarding spans both services.' } },
      opts(),
    );

    expect(search('onboarding')).toHaveLength(1);
  });

  // An archived memory stays indexed so it can still be found on request.
  test('archive_memory keeps the row and flips its status', async () => {
    await createMemory(input, opts({ makeId: () => 'mem_SYNC0004' }));
    await archiveMemory(
      { id: 'mem_SYNC0004', reason: 'The services merged.' },
      { memoriesDir, index },
    );

    expect(index.count()).toBe(1);
    expect(search('billing checkout')).toHaveLength(0);
    expect(search('billing checkout', ['archived'])).toHaveLength(1);
  });

  test('a gated create adds nothing to the index', async () => {
    await createMemory(input, opts({ makeId: () => 'mem_SYNC0005' }));
    const gated = await createMemory(input, opts({ makeId: () => 'mem_SYNC0006' }));

    expect(gated.outcome).toBe('duplicate_candidates');
    expect(index.count()).toBe(1);
  });
});
