import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AccountStores, MAX_OPEN_ACCOUNT_STORES } from '../src/accounts.js';
import { createServer, type StoreContext } from '../src/server.js';

let dataDir: string;
let stores: AccountStores;
const clients: Client[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'memento-accounts-'));
  stores = new AccountStores(dataDir);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await stores.close().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

async function connect(store: StoreContext) {
  const server = await createServer(store);
  const client = new Client({ name: 'account-test', version: '1' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

async function structured(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent!;
}

const projectInput = { name: 'Billing', description: 'The billing service.' };

const memory = {
  title: 'Invoice retries duplicate charges',
  description: 'Deduplicate invoices using provider event identifiers.',
  body: 'Retrying invoice submission without an idempotency key double-charges.',
  scope: { kind: 'global' },
  type: 'debugging_pattern',
  provenance: { source: 'agent_observed' },
};

describe('account stores', () => {
  test('caches concurrent opens, ignores MEMENTO_HOME, and loads explicit account config', async () => {
    const home = join(dataDir, 'accounts', 'alpha');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ logging_enabled: false }));
    vi.stubEnv('MEMENTO_HOME', join(dataDir, 'must-not-be-used'));
    const first = stores.get('alpha');
    expect(stores.get('alpha')).toBe(first);
    const store = await first;
    expect(store.resolved.paths.home).toBe(await realpath(home));
    expect(store.resolved.config.logging_enabled).toBe(false);
    expect(Object.isFrozen(store.resolved.paths)).toBe(true);
  });

  test.each([
    '',
    '..',
    '../beta',
    '/tmp/account',
    'a/b',
    'a\\b',
    'alpha.beta',
    ' alpha',
    'ALPHA',
    'a'.repeat(129),
  ])('rejects unsafe account id %j', async (id) => {
    await expect(stores.get(id)).rejects.toThrow('Invalid account id');
  });

  test.each([
    'accounts',
    'accounts/alpha',
    'accounts/alpha/memories',
    'accounts/alpha/config.json',
    'accounts/alpha/index',
  ])('rejects symlink at %s without writing through it', async (relative) => {
    const outside = await mkdtemp(join(tmpdir(), 'memento-outside-'));
    try {
      const parts = relative.split('/');
      await mkdir(join(dataDir, ...parts.slice(0, -1)), { recursive: true });
      await symlink(outside, join(dataDir, relative));
      await expect(stores.get('alpha')).rejects.toThrow(/symlink/i);
      await expect(readFile(join(outside, 'memory.sqlite'))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a failed opening can be retried', async () => {
    const home = join(dataDir, 'accounts', 'alpha');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), '{');
    await expect(stores.get('alpha')).rejects.toThrow('Invalid config JSON');
    await rm(join(home, 'config.json'));
    expect(await stores.get('alpha')).toBeDefined();
  });

  test('bounds the cache including in-flight opens and drains them on close', async () => {
    const opening = Array.from({ length: MAX_OPEN_ACCOUNT_STORES }, (_, i) => stores.get(`a${i}`));
    await expect(stores.get('overflow')).rejects.toThrow('limit');
    const closing = stores.close();
    expect(stores.close()).toBe(closing);
    await expect(stores.get('a0')).rejects.toThrow('closed');
    await closing;
    for (const store of await Promise.all(opening)) {
      await expect(store.enqueue(() => 1)).rejects.toThrow('closed');
    }
  });

  test('isolates projects, memory ids, reads, search, and mutations across accounts', async () => {
    const a = (await connect(await stores.get('alpha'))).client;
    const b = (await connect(await stores.get('beta'))).client;
    const project = await structured(a, 'create_project', projectInput);
    const created = await structured(a, 'create_memory', memory);
    expect(await structured(b, 'resolve_project', { name_hint: 'Billing' })).toEqual({
      outcome: 'not_found',
    });
    expect(
      await structured(b, 'search_memories', {
        query: 'invoice retries',
        scope: { kind: 'global' },
      }),
    ).toMatchObject({ result_count: 0 });
    for (const [tool, args] of [
      ['get_memory', { id: created.id }],
      ['update_memory', { id: created.id, changes: { body: 'Stolen' } }],
      ['archive_memory', { id: created.id, reason: 'Stolen' }],
      ['update_project', { id: project.id, name: 'Stolen' }],
      ['create_memory', { ...memory, scope: { kind: 'projects', project_ids: [project.id] } }],
    ] as const) {
      expect((await call(b, tool, args)).isError, tool).toBe(true);
    }
    expect(await structured(a, 'get_memory', { id: created.id })).toMatchObject({
      body: memory.body,
    });
    expect(await structured(b, 'create_memory', memory)).toMatchObject({ outcome: 'created' });
  });

  test('same-account clients serialize check-write operations and closing either leaves the store live', async () => {
    const store = await stores.get('alpha');
    const a = await connect(store);
    const b = await connect(await stores.get('alpha'));
    const results = await Promise.all([
      call(a.client, 'create_project', projectInput),
      call(b.client, 'create_project', projectInput),
    ]);
    expect(results.filter((r) => r.structuredContent?.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.isError)).toHaveLength(1);
    await a.server.close();
    const created = await structured(b.client, 'create_memory', memory);
    await b.client.close();
    const c = await connect(store);
    expect(await structured(c.client, 'get_memory', { id: created.id })).toMatchObject({
      body: memory.body,
    });
    expect(await structured(c.client, 'resolve_project', { name_hint: 'Billing' })).toMatchObject({
      outcome: 'exact_match',
    });
  });
});
