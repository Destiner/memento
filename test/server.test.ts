import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { createServer, openStore, type StoreContext } from '../src/server.js';
import { MemoryIndex } from '../src/store/search-index.js';

let home: string;
let resolved: ResolvedConfig;
let store: StoreContext | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'memento-context-'));
  resolved = loadConfig(home);
  resolved.config.logging_enabled = false;
});
afterEach(async () => {
  await store?.close();
  store = undefined;
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

test('store close drains accepted operations, rejects new operations, and closes once', async () => {
  store = await openStore(resolved);
  const closeIndex = vi.spyOn(store.index, 'close');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const first = store.enqueue(async () => {
    await gate;
    calls.push('first');
  });
  const failure = store.enqueue(() => {
    throw new Error('operation failed');
  });
  const failed = expect(failure).rejects.toThrow('operation failed');
  const last = store.enqueue(() => calls.push('last'));
  const closing = store.close();
  expect(store.close()).toBe(closing);
  expect(closeIndex).not.toHaveBeenCalled();
  await expect(store.enqueue(() => undefined)).rejects.toThrow('closed');
  release();
  await Promise.all([first, failed, last, closing]);
  expect(calls).toEqual(['first', 'last']);
  expect(closeIndex).toHaveBeenCalledTimes(1);
});

test('config-based server owns and closes its index on explicit close', async () => {
  const closeIndex = vi.spyOn(MemoryIndex.prototype, 'close');
  const server = await createServer(resolved);
  await server.close();
  await server.close();
  expect(closeIndex).toHaveBeenCalledTimes(1);
});

test('config-based server closes its store when the client disconnects', async () => {
  const closeIndex = vi.spyOn(MemoryIndex.prototype, 'close');
  const server = await createServer(resolved);
  const client = new Client({ name: 'lifetime-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.close();
  await vi.waitFor(() => expect(closeIndex).toHaveBeenCalledTimes(1));
});

test('a borrowed server neither opens another index nor closes the shared index', async () => {
  store = await openStore(resolved);
  const closeIndex = vi.spyOn(store.index, 'close');
  const server = await createServer(store);
  await server.close();
  expect(closeIndex).not.toHaveBeenCalled();
  expect(await store.enqueue(() => 42)).toBe(42);
  await store.close();
  expect(closeIndex).toHaveBeenCalledTimes(1);
});
