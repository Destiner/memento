// The eight tools as an agent sees them (v2.md §4, §5): registered on the real
// MCP server and driven end to end over an in-memory transport.
//
// This is the only test that exercises the wiring rather than the operations —
// that every tool is registered under its frozen name, that a soft outcome comes
// back as a success rather than an error, that the flattened tool payloads match
// the advertised output schemas, and that each tool emits the instrumentation
// event the report is built on.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolvePaths, type ResolvedConfig } from '../../src/config.js';
import {
  LOG_FILE_PATTERN,
  LOG_SCHEMA_VERSION,
  type LoggedEvent,
} from '../../src/logging/events.js';
import { POLICY_VERSION } from '../../src/policy/index.js';
import { createServer, SERVER_VERSION } from '../../src/server.js';

const TOOLS = [
  'archive_memory',
  'create_memory',
  'create_project',
  'get_memory',
  'resolve_project',
  'search_memories',
  'update_memory',
  'update_project',
];

interface CallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const CLIENT_NAME = 'test-agent';
const CLIENT_VERSION = '0.0.0';

async function startServer(loggingEnabled: boolean): Promise<{ home: string; client: Client }> {
  const home = mkdtempSync(join(tmpdir(), 'memento-tools-'));
  const resolved: ResolvedConfig = {
    paths: resolvePaths(home),
    config: {
      schema_version: 1,
      search_backend: 'fts5',
      default_result_limit: 5,
      max_result_limit: 10,
      logging_enabled: loggingEnabled,
    },
    variant: 'shipped-v2',
  };

  const server = await createServer(resolved);
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { home, client };
}

describe('tool surface', () => {
  let home: string;
  let client: Client;

  beforeEach(async () => {
    // Nothing to learn from log files here, and it keeps the run pure.
    ({ home, client } = await startServer(false));
  });

  afterEach(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    return (await client.callTool({ name, arguments: args })) as CallResult;
  }

  async function structured(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    expect(result.isError, `${name} failed: ${JSON.stringify(result)}`).toBeFalsy();
    return result.structuredContent!;
  }

  test('registers exactly the eight frozen tools', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('walks the full project-then-memory path', async () => {
    // Nothing registered yet: resolution is a soft not_found, not an error.
    const missing = await structured('resolve_project', { name_hint: 'Alpha' });
    expect(missing).toEqual({ outcome: 'not_found' });

    const created = await structured('create_project', {
      name: 'Alpha',
      description: 'The billing service.',
    });
    expect(created.outcome).toBe('created');
    const projectId = created.id as string;

    const resolved = await structured('resolve_project', { name_hint: 'alpha' });
    expect(resolved).toMatchObject({
      outcome: 'exact_match',
      matched_on: 'name',
      project: { id: projectId, name: 'Alpha' },
      suggestions: [],
    });

    const updated = await structured('update_project', {
      id: projectId,
      identifiers: { git_remotes: ['git@github.com:acme/alpha.git'] },
    });
    expect(updated).toMatchObject({
      updated: true,
      project: { identifiers: { git_remotes: ['github.com/acme/alpha'] } },
    });

    const memory = await structured('create_memory', {
      title: 'Invoice retries duplicate charges',
      description: 'Retrying invoice submission without an idempotency key double-charges.',
      scope: { kind: 'projects', project_ids: [projectId] },
      type: 'debugging_pattern',
      body: 'Deduplicate by event id; the provider retries with backoff.',
      provenance: { source: 'agent_observed' },
    });
    expect(memory.outcome).toBe('created');
    const memoryId = memory.id as string;

    const found = await structured('search_memories', {
      query: 'invoice retries duplicate charges',
      scope: { kind: 'projects', project_ids: [projectId] },
    });
    expect(found.result_count).toBe(1);
    const [hit] = found.results as Record<string, unknown>[];
    expect(hit).toMatchObject({ id: memoryId, title: 'Invoice retries duplicate charges' });
    expect(hit).not.toHaveProperty('body');

    const full = await structured('get_memory', { id: memoryId });
    expect(full).toMatchObject({
      id: memoryId,
      body: 'Deduplicate by event id; the provider retries with backoff.',
      provenance: { source: 'agent_observed', verification: 'observed_once' },
      projects: [{ id: projectId, name: 'Alpha' }],
    });

    const edited = await structured('update_memory', {
      id: memoryId,
      changes: { description: 'Retrying invoice submission without idempotency double-charges.' },
      mark_verified: true,
    });
    expect(edited).toMatchObject({ id: memoryId, updated: true, dropped_evidence: [] });

    const archived = await structured('archive_memory', {
      id: memoryId,
      reason: 'The provider now enforces idempotency keys.',
    });
    expect(archived).toMatchObject({ id: memoryId, archived: true });

    const afterArchive = await structured('search_memories', {
      query: 'invoice retries duplicate charges',
      scope: { kind: 'projects', project_ids: [projectId] },
    });
    expect(afterArchive.result_count).toBe(0);
  });

  // Both gates answer rather than fail: an error response would read to an agent
  // as "this tool is broken" instead of "here is what to do next".
  test('a gated create is a success carrying candidates', async () => {
    const project = await structured('create_project', {
      name: 'Alpha',
      description: 'The billing service.',
    });
    const projectId = project.id as string;

    const input = {
      title: 'Invoice retries duplicate charges',
      description: 'Retrying invoice submission without an idempotency key double-charges.',
      scope: { kind: 'projects', project_ids: [projectId] },
      type: 'debugging_pattern',
      body: 'Deduplicate by event id.',
      provenance: { source: 'agent_observed' },
    };
    await structured('create_memory', input);

    const gated = await structured('create_memory', input);
    expect(gated.outcome).toBe('duplicate_candidates');
    expect(gated.candidates).toHaveLength(1);
    expect(gated.id).toBeUndefined();

    const gatedProject = await structured('create_project', {
      name: 'Alpha Service',
      description: 'The billing service.',
    });
    expect(gatedProject.outcome).toBe('duplicate_candidates');
    expect(gatedProject.candidates).toHaveLength(1);
  });

  test('a validation failure comes back as a tool error', async () => {
    const result = await call('create_memory', {
      title: 'Missing most of its fields',
      scope: { kind: 'global' },
    });

    expect(result.isError).toBe(true);
  });

  test('an unregistered project id is refused', async () => {
    const result = await call('search_memories', {
      query: 'anything',
      scope: { kind: 'projects', project_ids: ['prj_GHOST'] },
    });

    expect(result.isError).toBe(true);
  });
});

// The report is only as good as what the server actually writes, and the writes
// are fire-and-forget — a field that silently stops being emitted would show up
// as a metric quietly reading zero, not as a failure. These tests read the real
// log file back off disk.
describe('instrumentation', () => {
  let home: string;
  let client: Client;

  beforeEach(async () => {
    ({ home, client } = await startServer(true));
  });

  afterEach(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function structured(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as CallResult;
    expect(result.isError, `${name} failed: ${JSON.stringify(result)}`).toBeFalsy();
    return result.structuredContent!;
  }

  function readEvents(): LoggedEvent[] {
    const logsDir = resolvePaths(home).logs;
    let files: string[];
    try {
      files = readdirSync(logsDir).filter((name) => LOG_FILE_PATTERN.test(name));
    } catch {
      return [];
    }
    return files.sort().flatMap((file) =>
      readFileSync(join(logsDir, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as LoggedEvent),
    );
  }

  // Logging is deliberately fire-and-forget, so a tool call can return before its
  // append settles. Poll rather than sleep a fixed amount.
  async function waitForEvents(expected: number): Promise<LoggedEvent[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const events = readEvents();
      if (events.length >= expected) return events;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expected} events; saw ${readEvents().length}.`);
  }

  // One walk through every tool, then assert over the events it produced.
  async function exerciseEveryTool(): Promise<{ projectId: string; memoryId: string }> {
    await structured('resolve_project', { name_hint: 'Alpha' });
    const project = await structured('create_project', {
      name: 'Alpha',
      description: 'The billing service.',
    });
    const projectId = project.id as string;
    await structured('update_project', {
      id: projectId,
      identifiers: { git_remotes: ['git@github.com:acme/alpha.git'] },
    });

    const input = {
      title: 'Invoice retries duplicate charges',
      description: 'Retrying invoice submission without an idempotency key double-charges.',
      scope: { kind: 'projects', project_ids: [projectId] },
      type: 'debugging_pattern',
      body: 'Deduplicate by event id; the provider retries with backoff.',
      provenance: { source: 'agent_observed' },
    };
    const memory = await structured('create_memory', input);
    const memoryId = memory.id as string;
    await structured('create_memory', input); // gated by the near-duplicate check
    await structured('search_memories', {
      query: 'invoice retries duplicate charges',
      scope: { kind: 'projects', project_ids: [projectId] },
    });
    await structured('get_memory', { id: memoryId });
    await structured('update_memory', { id: memoryId, changes: { description: 'Reworded.' } });
    await structured('archive_memory', { id: memoryId, reason: 'Provider enforces keys now.' });

    return { projectId, memoryId };
  }

  test('stamps every event with the session, version, and client envelope', async () => {
    await exerciseEveryTool();
    const events = await waitForEvents(9);

    const sessions = new Set(events.map((event) => event.session_id));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);

    for (const event of events) {
      expect(event).toMatchObject({
        server_version: SERVER_VERSION,
        // Instruction text and server version move independently, so a comparison
        // that only knows one of them credits the wrong variable.
        policy_version: POLICY_VERSION,
        variant: 'shipped-v2',
        client_name: CLIENT_NAME,
        client_version: CLIENT_VERSION,
        log_schema_version: LOG_SCHEMA_VERSION,
      });
    }
  });

  test('records the ids that make reuse and per-project activation answerable', async () => {
    const { projectId, memoryId } = await exerciseEveryTool();
    const events = await waitForEvents(9);
    const byTool = new Map(events.map((event) => [event.tool, event]));

    expect(byTool.get('create_project')).toMatchObject({ project_ids: [projectId] });
    expect(byTool.get('update_project')).toMatchObject({ project_ids: [projectId] });
    expect(byTool.get('search_memories')).toMatchObject({
      project_ids: [projectId],
      result_ids: [memoryId],
    });
    expect(byTool.get('get_memory')).toMatchObject({
      memory_id: memoryId,
      project_ids: [projectId],
    });
    expect(byTool.get('update_memory')).toMatchObject({ memory_id: memoryId });
    expect(byTool.get('archive_memory')).toMatchObject({ memory_id: memoryId });

    const creates = events.filter((event) => event.tool === 'create_memory');
    expect(creates[0]).toMatchObject({ result_outcome: 'created', memory_id: memoryId });
    // A gated create names what it matched, so a repeated near-miss is traceable.
    expect(creates[1]).toMatchObject({
      result_outcome: 'duplicate_candidates',
      candidate_ids: [memoryId],
    });
    expect(creates[1]).not.toHaveProperty('memory_id');
  });

  test('writes ids and counts but never human-readable content', async () => {
    await exerciseEveryTool();
    const events = await waitForEvents(9);
    const raw = JSON.stringify(events);

    for (const secret of [
      'Invoice retries duplicate charges', // title
      'invoice retries duplicate charges', // query text
      'Deduplicate by event id', // body
      'Provider enforces keys now', // archive reason
      'The billing service', // project description
      'github.com/acme/alpha', // git remote
    ]) {
      expect(raw).not.toContain(secret);
    }
    // The lengths and counts derived from that content are fine to keep.
    expect(events.find((event) => event.tool === 'search_memories')?.query_length).toBe(
      'invoice retries duplicate charges'.length,
    );
  });
});
