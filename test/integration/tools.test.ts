// The eight tools as an agent sees them (v2.md §4, §5): registered on the real
// MCP server and driven end to end over an in-memory transport.
//
// This is the only test that exercises the wiring rather than the operations —
// that every tool is registered under its frozen name, that a soft outcome comes
// back as a success rather than an error, and that the flattened tool payloads
// match the advertised output schemas.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolvePaths, type ResolvedConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

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

describe('tool surface', () => {
  let home: string;
  let client: Client;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-tools-'));
    const resolved: ResolvedConfig = {
      paths: resolvePaths(home),
      config: {
        schema_version: 1,
        search_backend: 'fts5',
        default_result_limit: 5,
        max_result_limit: 10,
        // Nothing to learn from log files here, and it keeps the run pure.
        logging_enabled: false,
      },
      variant: 'shipped-v2',
    };

    const server = await createServer(resolved);
    client = new Client({ name: 'test-agent', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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
