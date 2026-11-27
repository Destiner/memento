import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { AccountDocument } from '../cloudflare/account-store.js';
import { serializeFrontmatter } from '../src/store/frontmatter.js';
import type { MemoryDetail } from '../src/store/memory-schema.js';

const NOW = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const globalScope = { kind: 'global' };
const memory = {
  title: 'Synthetic quaternion milestone',
  description: 'Quaternion milestone confirmed by the fixture.',
  body: 'Synthetic workerd record for the quaternion milestone.',
  type: 'other',
  provenance: { source: 'user_stated' },
  scope: globalScope,
};

let bundle: string;
let persistence: string;
let runtime: Miniflare;

function startRuntime(): Miniflare {
  const name = 'synthetic-account-store';
  return new Miniflare({
    resourcePersistencePath: persistence,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name,
          compatibilityDate: '2026-11-23',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.mjs',
            modules: { 'worker.mjs': { type: 'esm', contents: bundle } },
          },
          env: { ACCOUNT: { type: 'durable-object', worker: name, exportName: 'TestAccount' } },
          exports: { TestAccount: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    ],
  });
}

async function invoke<T = unknown>(account: string, action: string, args?: unknown, now = NOW) {
  const response = await runtime.dispatchFetch(`http://localhost/${account}`, {
    method: 'POST',
    body: JSON.stringify({ action, args, now }),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function step<T = unknown>(account: string, action: string, args?: unknown, now = NOW) {
  const { status, data } = await invoke<T>(account, action, args, now);
  expect(status, `${action}: ${JSON.stringify(data)}`).toBe(200);
  return data;
}

function search(account: string, query: string, scope = globalScope) {
  return step<{ result_count: number }>(account, 'search', { query, scope });
}

beforeAll(async () => {
  persistence = await mkdtemp(join(tmpdir(), 'memento-account-workerd-'));
  const output = await build({
    entryPoints: [fileURLToPath(new URL('./cloudflare-account-store-worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['browser', 'module', 'main'],
    external: ['node:*'],
    write: false,
  });
  bundle = output.outputFiles[0]!.text;
  runtime = startRuntime();
}, 30_000);

afterAll(async () => {
  await runtime?.dispose();
  if (persistence) await rm(persistence, { recursive: true, force: true });
});

describe('SQLite account store in workerd', () => {
  test('persists all eight operations and retention across requests and a restart', async () => {
    const record = {
      id: 'mem_fixture',
      title: 'Synthetic migrated lattice',
      description: 'The fixture predates the configured retention window.',
      type: 'other',
      scope: globalScope,
      provenance: { source: 'user_stated', verification: 'user_confirmed' },
      status: 'active',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const imported: AccountDocument[] = [
      {
        path: 'config.json',
        contents: '{"memory_archive_after_days":1,"memory_delete_after_days":1}\n',
      },
      {
        path: 'memories/renamed lattice.md',
        contents: serializeFrontmatter(record, 'Synthetic 🧪 lattice body.'),
      },
    ];
    await step('alpha', 'import', imported);
    expect(await step('alpha', 'documents')).toEqual(imported);
    expect(await step('alpha', 'config')).toMatchObject({ memory_archive_after_days: 1 });
    expect(await search('alpha', 'lattice')).toMatchObject({ result_count: 1 });
    expect((await invoke('alpha', 'import', [])).status).toBe(400);

    const project = await step<{ id: string }>('alpha', 'createProject', {
      name: 'Synthetic geometry',
      description: 'A test project for geometry notes.',
      working_directories: ['/synthetic/geometry'],
    });
    expect(
      await step('alpha', 'resolveProject', { working_directory: '/synthetic/geometry' }),
    ).toMatchObject({ outcome: 'exact_match', project: { id: project.id } });
    await step('alpha', 'updateProject', { id: project.id, aliases: ['Geometer fixture'] });
    expect(await step('alpha', 'resolveProject', { name_hint: 'Geometer fixture' })).toMatchObject({
      outcome: 'exact_match',
      project: { id: project.id },
    });

    const scope = { kind: 'projects', project_ids: [project.id] };
    const created = await step<{ id: string; path: string }>('alpha', 'createMemory', {
      ...memory,
      scope,
    });
    expect(
      await step('alpha', 'updateMemory', {
        id: created.id,
        body: 'Updated synthetic quaternion body.',
        changes: { title: 'Synthetic quaternion revised' },
      }),
    ).toMatchObject({ id: created.id, updated: true });
    expect(
      (await step<AccountDocument[]>('alpha', 'documents')).map(({ path }) => path),
    ).not.toContain(`memories/${created.path.split('/').at(-1)}`);
    expect(await search('alpha', 'quaternion', scope)).toMatchObject({ result_count: 1 });
    expect(await step('alpha', 'getMemory', { id: created.id })).toMatchObject({
      body: 'Updated synthetic quaternion body.',
      projects: [{ id: project.id }],
    });

    expect(await step('alpha', 'decay')).toMatchObject({ archived: 1, deleted: 0 });
    expect(await search('alpha', 'lattice')).toMatchObject({ result_count: 0 });
    const accessed = await step<MemoryDetail>(
      'alpha',
      'getMemory',
      { id: record.id },
      NOW + 10_000,
    );
    expect(accessed).toMatchObject({ status: 'active', body: 'Synthetic 🧪 lattice body.' });
    expect(accessed.last_accessed_at).toBe('2026-01-01T00:00:10Z');
    expect(
      await step('alpha', 'archiveMemory', {
        id: created.id,
        reason: 'Synthetic milestone retired.',
      }),
    ).toMatchObject({ archived: true, memory: { status: 'archived' } });

    await runtime.dispose();
    runtime = startRuntime();
    expect(await search('alpha', 'lattice')).toMatchObject({ result_count: 1 });
    expect(await step<AccountDocument[]>('alpha', 'documents')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: imported[1]!.path,
          contents: expect.stringContaining('last_accessed_at: 2026-01-01T00:00:10Z'),
        }),
      ]),
    );
    expect(await step('alpha', 'decay', undefined, NOW + DAY + 1_000)).toMatchObject({
      archived: 0,
      deleted: 1,
    });
    expect((await invoke('alpha', 'getMemory', { id: created.id })).status).toBe(400);
    expect(await search('beta', 'lattice')).toMatchObject({ result_count: 0 });
    expect((await invoke('beta', 'getMemory', { id: record.id })).status).toBe(400);
  }, 30_000);

  test('handles interruptions and enforces atomic capacity and import checks', async () => {
    const account = 'recovery';
    await step(account, 'createMemory', memory);
    const attempted = {
      ...memory,
      title: 'Synthetic xenolith',
      description: 'Different synthetic topic.',
      body: 'Xenolith evidence for the test.',
    };
    expect((await invoke(account, 'failAfterCreate', attempted)).status).toBe(400);
    await runtime.dispose();
    runtime = startRuntime();
    expect(await search(account, 'xenolith')).toMatchObject({ result_count: 0 });
    expect((await invoke(account, 'overLimit', attempted)).status).toBe(400);
    expect(await step<AccountDocument[]>(account, 'documents')).toHaveLength(1);
    expect(await search(account, 'xenolith')).toMatchObject({ result_count: 0 });
    expect(await step(account, 'caughtToolError')).toBe(false);
    expect(await search(account, 'quaternion')).toMatchObject({ result_count: 1 });
    expect(await step(account, 'stageStaleScratch')).toBe(true);
    expect(await step(account, 'scratch')).toBe(true);

    const safe = { path: 'config.json', contents: '{"logging_enabled":false}' };
    expect(
      (await invoke('import', 'import', [safe, { path: 'memories/../escape.md', contents: 'no' }]))
        .status,
    ).toBe(400);
    expect((await invoke('import', 'import', [safe, safe])).status).toBe(400);
    expect(await step('import', 'documents')).toEqual([]);
    const imported = [
      safe,
      ...['.memento-document-0.md', 'x y.md', 'x%20y.md'].map((name) => ({
        path: `memories/${name}`,
        contents: `synthetic non-indexable markdown for ${name}`,
      })),
    ];
    await step('import', 'import', imported);
    await step('import', 'config');
    const documents = await step<AccountDocument[]>('import', 'documents');
    expect(documents).toHaveLength(imported.length);
    expect(documents).toEqual(expect.arrayContaining(imported));
    await step('initialized-empty', 'config');
    expect((await invoke('initialized-empty', 'import', [safe])).status).toBe(400);
  }, 30_000);

  test('rolls back canonical changes if the final SQLite transaction fails', async () => {
    const account = 'failed-commit';
    await step(account, 'createMemory', memory);
    const before = await step<AccountDocument[]>(account, 'documents');
    const result = await invoke(account, 'rejectEventCommit', {
      ...memory,
      title: 'Synthetic xenolith',
      description: 'Different synthetic topic.',
      body: 'Xenolith evidence for the test.',
    });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('synthetic commit failure') },
    });
    expect(await step(account, 'documents')).toEqual(before);
    expect(await step(account, 'logs')).toEqual([]);
    expect(await search(account, 'xenolith')).toMatchObject({ result_count: 0 });
    expect(await search(account, 'quaternion')).toMatchObject({ result_count: 1 });
  });

  test.each(['dropSearchIndex', 'oldSearchSchema'])(
    'recreates the derived index from canonical documents after %s',
    async (fault) => {
      await step(fault, 'createMemory', memory);
      const before = await step<AccountDocument[]>(fault, 'documents');
      expect(await search(fault, 'quaternion')).toMatchObject({ result_count: 1 });
      await step(fault, fault);
      expect(await search(fault, 'quaternion')).toMatchObject({ result_count: 1 });
      expect(await step(fault, 'documents')).toEqual(before);
    },
  );

  test('keeps bounded events in the originating account', async () => {
    for (let batch = 0; batch < 9; batch++) {
      await Promise.all([
        step('logging', 'logBatch', `synthetic-client-${batch}`),
        step('other-logging', 'logBatch', 'different synthetic client'),
      ]);
    }
    const logs = await step<{ client_name: string; tool: string }[]>('logging', 'logs');
    expect(logs).toHaveLength(256);
    expect(logs[0]).toMatchObject({ client_name: 'synthetic-client-1', tool: 'get_memory' });
    expect(logs.at(-1)?.client_name).toBe('synthetic-client-8');
    const other = await step<{ client_name: string }[]>('other-logging', 'logs');
    expect(other.every((event) => event.client_name === 'different synthetic client')).toBe(true);
    await step('logging-disabled', 'import', [
      { path: 'config.json', contents: '{"logging_enabled":false}' },
    ]);
    await step('logging-disabled', 'logBatch', 'not logged');
    expect(await step('logging-disabled', 'logs')).toEqual([]);
  }, 30_000);
});
