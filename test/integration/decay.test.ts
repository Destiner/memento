import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG, resolvePaths } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/store/frontmatter.js';
import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { memoryRecord } from '../helpers/memories.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-06-01T00:00:00Z');
const ID = 'mem_TEST0000';
const BODY = 'Preserve idempotency keys for webhook retries.';
const iso = (time: number) => new Date(time).toISOString().replace('.000Z', 'Z');

describe('memory decay over MCP', () => {
  let home: string;
  let paths: ReturnType<typeof resolvePaths>;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START);
    home = mkdtempSync(join(tmpdir(), 'memento-decay-'));
    paths = resolvePaths(home);
    mkdirSync(paths.memories, { recursive: true });
  });

  afterEach(async () => {
    try {
      await server?.close();
      await client?.close();
    } finally {
      server = undefined;
      client = undefined;
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  function seed(overrides: Partial<MemoryRecord> = {}) {
    const record = memoryRecord({
      scope: { kind: 'global' },
      created_at: iso(START - 91 * DAY),
      updated_at: iso(START - 91 * DAY),
      ...overrides,
    });
    writeFileSync(join(paths.memories, 'hand-renamed.md'), serializeFrontmatter(record, BODY));
  }

  function stored() {
    return parseFrontmatter(readFileSync(join(paths.memories, 'hand-renamed.md'), 'utf8'));
  }

  async function start() {
    server = await createServer({
      paths,
      config: { ...DEFAULT_CONFIG, logging_enabled: false },
      variant: 'shipped-v2',
    });
    client = new Client({ name: 'decay-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client!.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent!;
  }

  async function search(filters: Record<string, unknown> = {}) {
    return call('search_memories', {
      query: 'webhook',
      scope: { kind: 'global' },
      ...filters,
    });
  }

  test('startup archives stale active files and search cannot bypass the archived gate', async () => {
    seed();
    await start();
    expect(stored().metadata).toMatchObject({
      status: 'archived',
      archive_source: 'decay',
      archived_at: iso(START),
    });
    expect(stored().body).toBe(BODY);
    expect(await search()).toMatchObject({ result_count: 0 });
    expect(await search({ include_archived: false, status: ['archived'] })).toMatchObject({
      result_count: 0,
    });
    expect(await search({ status: ['archived'] })).toMatchObject({ result_count: 0 });
    expect(await search({ include_archived: true })).toMatchObject({
      result_count: 1,
      results: [{ id: ID, status: 'archived' }],
    });
    expect(await search({ include_archived: true, status: ['active'] })).toMatchObject({
      result_count: 0,
    });
    expect(await search({ include_archived: true, status: ['archived'] })).toMatchObject({
      result_count: 1,
    });
    expect(stored().metadata.last_accessed_at).toBeUndefined();
  });

  test('search performs maintenance without waiting for the hourly interval', async () => {
    seed({ created_at: iso(START), updated_at: iso(START) });
    await start();
    vi.setSystemTime(START + DEFAULT_CONFIG.memory_archive_after_days * DAY);
    expect(stored().metadata.status).toBe('active');
    expect(await search()).toMatchObject({ result_count: 0 });
    expect(stored().metadata).toMatchObject({
      status: 'archived',
      archive_source: 'decay',
      archived_at: iso(Date.now()),
    });
    expect(await search({ include_archived: true })).toMatchObject({ result_count: 1 });
    vi.setSystemTime(Date.now() + DEFAULT_CONFIG.memory_delete_after_days * DAY);
    expect(await search({ include_archived: true })).toMatchObject({ result_count: 0 });
    expect(existsSync(join(paths.memories, 'hand-renamed.md'))).toBe(false);
  });

  test('get rescues an overdue decay archive before maintenance and restores the index', async () => {
    seed();
    await start();
    vi.setSystemTime(START + (DEFAULT_CONFIG.memory_delete_after_days + 1) * DAY);
    const result = await call('get_memory', { id: ID });
    expect(result).toMatchObject({
      id: ID,
      status: 'active',
      body: BODY,
      last_accessed_at: iso(Date.now()),
    });
    for (const field of ['archive_source', 'archive_reason', 'archived_at']) {
      expect(result).not.toHaveProperty(field);
      expect(stored().metadata).not.toHaveProperty(field);
    }
    expect(stored().metadata).toMatchObject({
      status: 'active',
      last_accessed_at: iso(Date.now()),
      updated_at: iso(Date.now()),
    });
    expect(await search()).toMatchObject({
      result_count: 1,
      results: [{ id: ID, status: 'active' }],
    });
  });

  test('get tracks access but leaves a manual archive archived in storage and search', async () => {
    seed({
      status: 'archived',
      archive_source: 'manual',
      archived_at: iso(START),
      archive_reason: 'Retired deliberately.',
    });
    await start();
    vi.setSystemTime(START + (DEFAULT_CONFIG.memory_delete_after_days + 1) * DAY);
    expect(await call('get_memory', { id: ID })).toMatchObject({
      status: 'archived',
      archive_source: 'manual',
      archive_reason: 'Retired deliberately.',
      archived_at: iso(START),
      last_accessed_at: iso(Date.now()),
      body: BODY,
    });
    expect(stored().metadata).toMatchObject({
      status: 'archived',
      archive_source: 'manual',
      last_accessed_at: iso(Date.now()),
    });
    expect(await search()).toMatchObject({ result_count: 0 });
    expect(await search({ include_archived: true })).toMatchObject({
      result_count: 1,
      results: [{ id: ID, status: 'archived' }],
    });
  });

  test('hourly maintenance archives and deletes without requests, and close cancels the timer', async () => {
    seed({ created_at: iso(START), updated_at: iso(START) });
    await start();
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(START + DEFAULT_CONFIG.memory_archive_after_days * DAY - HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(() => expect(stored().metadata.status).toBe('archived'));
    const archivedAt = Date.parse(String(stored().metadata.archived_at));
    vi.setSystemTime(archivedAt + DEFAULT_CONFIG.memory_delete_after_days * DAY - 2 * HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(existsSync(join(paths.memories, 'hand-renamed.md'))).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(() => expect(existsSync(join(paths.memories, 'hand-renamed.md'))).toBe(false));
    await server!.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(vi.getTimerCount()).toBe(0);
  });
});
