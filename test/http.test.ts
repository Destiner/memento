import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AccountStores } from '../src/accounts.js';
import type { AuthService } from '../src/auth/index.js';
import { createApplication } from '../src/http.js';
import { bufferRequest } from '../src/request-body.js';

const origin = 'https://memento.example.com';
let home: string;
let accounts: AccountStores;
let app: ReturnType<typeof createApplication>;
let admitted: Set<string>;
const clients: Client[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'memento-http-'));
  accounts = new AccountStores(home);
  admitted = new Set(['work', 'personal']);
  const auth: AuthService = {
    authenticate: vi.fn(async (request) => {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      return token && admitted.has(token)
        ? { accountId: token, email: `${token}@example.com` }
        : null;
    }),
    handle: vi.fn(async () => new Response('auth route')),
    close: async () => undefined,
  };
  app = createApplication({ origin, auth, accounts });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app.drain();
  await accounts.close();
  await rm(home, { recursive: true, force: true });
});
async function connect(token: string) {
  const client = new Client({ name: 'http-test', version: '1' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  );
  return client;
}

test('admits uploads before buffering and includes them in shutdown draining', async () => {
  app = createApplication({
    origin,
    accounts,
    auth: {
      authenticate: async () => null,
      close: async () => undefined,
      handle: async (request) => {
        await bufferRequest(request, 16384);
        return new Response('done');
      },
    },
  });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const uploads = Array.from({ length: 64 }, () =>
    app.fetch(
      new Request(`${origin}/upload`, {
        method: 'POST',
        body: new ReadableStream<Uint8Array>({
          start(c) {
            controllers.push(c);
          },
        }),
        duplex: 'half',
      } as RequestInit),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(
    (await app.fetch(new Request(`${origin}/upload`, { method: 'POST', body: '{}' }))).status,
  ).toBe(503);
  let finished = false;
  const draining = app.drain().then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  for (const controller of controllers) controller.close();
  await Promise.all(uploads);
  await draining;
  expect(finished).toBe(true);
});

test('health is public; MCP requires a bearer, never browser cookies', async () => {
  expect((await app.fetch(new Request(`${origin}/health`))).status).toBe(200);
  const denied = await app.fetch(
    new Request(`${origin}/mcp`, { method: 'POST', headers: { Cookie: 'session=anything' } }),
  );
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toContain(
    '/.well-known/oauth-protected-resource/mcp',
  );
});

test('rejects untrusted Host and Origin without relying on forwarded headers', async () => {
  expect(
    (
      await app.fetch(
        new Request('https://evil.example/mcp', {
          headers: { 'x-forwarded-host': new URL(origin).host },
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await app.fetch(new Request(`${origin}/mcp`, { headers: { Origin: 'https://evil.example' } })))
      .status,
  ).toBe(403);
});

test('actual SDK HTTP calls stay account-isolated, survive disconnect and emit telemetry', async () => {
  const work = await connect('work');
  const personal = await connect('personal');
  const created = await work.callTool({
    name: 'create_memory',
    arguments: {
      title: 'Shared HTTP deployment decision',
      description: 'A durable deployment choice.',
      body: 'Use one file-owned remote memory bank per account.',
      scope: { kind: 'global' },
      type: 'decision_history',
      provenance: { source: 'user_stated' },
    },
  });
  expect(created.isError).not.toBe(true);
  const id = created.structuredContent?.id;
  expect(typeof id).toBe('string');
  const denied = await personal.callTool({ name: 'get_memory', arguments: { id } });
  expect(denied.isError).toBe(true);
  const otherWork = await connect('work');
  await work.close();
  const found = await otherWork.callTool({ name: 'get_memory', arguments: { id } });
  expect(found.isError).not.toBe(true);
  const empty = await personal.callTool({
    name: 'search_memories',
    arguments: { query: 'deployment', scope: { kind: 'global' } },
  });
  expect(empty.structuredContent?.result_count).toBe(0);
  const files = await readdir(join(home, 'accounts/work/logs'));
  const logs = (
    await Promise.all(files.map((file) => readFile(join(home, 'accounts/work/logs', file), 'utf8')))
  ).join('');
  expect(logs).toContain('create_memory');
  expect(logs).not.toContain('file-owned remote memory');
});

test('checks revoked authorization on the next call', async () => {
  const work = await connect('work');
  admitted.delete('work');
  await expect(work.listTools()).rejects.toThrow();
});

test('stateless HTTP has no GET stream or DELETE sessions', async () => {
  for (const method of ['GET', 'DELETE']) {
    const result = await app.fetch(
      new Request(`${origin}/mcp`, { method, headers: { Authorization: 'Bearer work' } }),
    );
    expect(result.status).toBe(405);
  }
});

test('limits request bodies and drains before shutdown', async () => {
  const result = await app.fetch(
    new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer work', 'Content-Type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    }),
  );
  expect(result.status).toBe(413);
  await app.drain();
  expect((await app.fetch(new Request(`${origin}/health`))).status).toBe(503);
  expect((await app.fetch(new Request(`${origin}/`))).status).toBe(503);
});
