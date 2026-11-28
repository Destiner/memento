import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { expect, test } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';

const root = fileURLToPath(new URL('../../', import.meta.url).href);
const origin = 'https://memory.example.test';
const resource = `${origin}/mcp`;
const redirect = 'http://127.0.0.1:49111/callback';
const verifier = 'v'.repeat(64);
const alice = 'alice@example.test';
const bob = 'bob@example.test';

function status(response: WorkerResponse, code: number) {
  expect(response.status, `${response.url} (${response.headers.get('location') ?? ''})`).toBe(code);
  return response;
}

function cookies(response: WorkerResponse) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

test('Wrangler-bundled Worker serves OAuth and persists isolated MCP writes before replying', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'memento-worker-integration-'));
  const persistence = join(scratch, 'persistence');
  const clients: Client[] = [];
  let runtime: Miniflare | undefined;
  try {
    const { rawConfig } = experimental_readRawConfig({ config: join(root, 'wrangler.jsonc') });
    const config = rawConfig as {
      name: string;
      compatibility_date: string;
      compatibility_flags: string[];
      workers_dev: boolean;
      preview_urls: boolean;
      routes?: unknown;
      route?: unknown;
      triggers?: unknown;
      durable_objects: { bindings: { name: string; class_name: string }[] };
      migrations: { new_sqlite_classes: string[] }[];
    };
    expect(config).toMatchObject({
      name: 'memento-cf-stage',
      workers_dev: false,
      preview_urls: false,
    });
    expect(config.routes ?? config.route ?? config.triggers).toBeUndefined();
    const outdir = join(scratch, 'bundle');
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        join(root, 'wrangler.jsonc'),
        '--outdir',
        outdir,
      ],
      { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 20_000 },
    );
    const contents = await readFile(join(outdir, 'worker.js'), 'utf8');
    let subject = 100;
    const env = Object.fromEntries(
      Object.entries({
        MEMENTO_PUBLIC_ORIGIN: origin,
        AUTH_ALLOWED_EMAILS: `${alice}, ${bob}`,
        BETTER_AUTH_SECRET: 'workerd-integration-only-000000000000000000',
        GITHUB_CLIENT_ID: 'synthetic-client-id',
        GITHUB_CLIENT_SECRET: 'synthetic-client-secret',
      }).map(([key, value]) => [key, { type: 'json' as const, value }]),
    );
    const bindings = Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [
        name,
        { type: 'durable-object' as const, worker: config.name, exportName: class_name },
      ]),
    );
    const exports = Object.fromEntries(
      config.migrations
        .flatMap(({ new_sqlite_classes }) => new_sqlite_classes)
        .map((name) => [name, { type: 'durable-object' as const, storage: 'sqlite' as const }]),
    );
    async function reopen() {
      await runtime?.dispose();
      runtime = new Miniflare({
        host: '127.0.0.1',
        cf: false,
        telemetry: { enabled: false },
        resourcePersistencePath: persistence,
        workers: [
          {
            config: {
              name: config.name,
              compatibilityDate: config.compatibility_date,
              compatibilityFlags: config.compatibility_flags,
              manifest: {
                mainModule: 'worker.mjs',
                modules: { 'worker.mjs': { type: 'esm', contents } },
              },
              env: { ...env, ...bindings },
              exports,
            },
            dev: {
              outboundService: {
                type: 'fetcher',
                async handler(request) {
                  const { origin, pathname } = new URL(request.url);
                  switch (`${request.method} ${origin}${pathname}`) {
                    case 'POST https://github.com/login/oauth/access_token':
                      return WorkerResponse.json({
                        access_token: 'synthetic-provider-token',
                        token_type: 'bearer',
                        scope: 'read:user,user:email',
                      });
                    case 'GET https://api.github.com/user':
                      return WorkerResponse.json({ id: subject, login: `fixture-${subject}` });
                    case 'GET https://api.github.com/user/emails':
                      return WorkerResponse.json([
                        { email: subject === 100 ? alice : bob, verified: true, primary: true },
                      ]);
                    default:
                      return new WorkerResponse('Unexpected outbound request', { status: 502 });
                  }
                },
              },
            },
          },
        ],
      });
    }
    const dispatch = (path: string, init?: Parameters<Miniflare['dispatchFetch']>[1]) =>
      runtime!.dispatchFetch(`${origin}${path}`, { ...init, redirect: 'manual' });
    const post = (path: string, body: object, cookie?: string) =>
      dispatch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(path === '/api/auth/oauth2/register' ? {} : { origin }),
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    const nav = { accept: 'text/html', 'MF-Sec-Fetch-Mode': 'navigate' };

    async function issue(email: string, clientId: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        resource,
        scope: 'mcp offline_access',
        state: 'fixture-state',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      const authorize = status(
        await dispatch(`/api/auth/oauth2/authorize?${params}`, { headers: nav }),
        302,
      );
      const login = new URL(authorize.headers.get('location')!, origin);
      expect(login.pathname).toBe('/oauth/login');
      expect(
        await status(await dispatch(`${login.pathname}${login.search}`), 200).text(),
      ).toContain('Continue with GitHub');
      const start = status(
        await post('/api/auth/sign-in/social', {
          provider: 'github',
          oauth_query: login.search.slice(1),
        }),
        200,
      );
      const provider = new URL(((await start.json()) as { url: string }).url);
      expect(provider.origin).toBe('https://github.com');
      const callbackParams = new URLSearchParams({
        code: 'fixture-code',
        state: provider.searchParams.get('state')!,
      });
      const callback = status(
        await dispatch(`/api/auth/callback/github?${callbackParams}`, {
          headers: { ...nav, cookie: cookies(start) },
        }),
        302,
      );
      const cookie = cookies(callback);
      expect(cookie).toContain('__Secure-better-auth.session_token');
      const consent = new URL(callback.headers.get('location')!, origin);
      expect(consent.pathname).toBe('/oauth/consent');
      expect(
        await status(
          await dispatch(`${consent.pathname}${consent.search}`, { headers: { cookie } }),
          200,
        ).text(),
      ).toContain(email);
      const approval = status(
        await post(
          '/api/auth/oauth2/consent',
          {
            accept: true,
            oauth_query: consent.search.slice(1),
          },
          cookie,
        ),
        200,
      );
      const redirectUrl = new URL(((await approval.json()) as { url: string }).url);
      expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(redirect);
      expect(redirectUrl.searchParams.get('state')).toBe('fixture-state');
      const exchanged = status(
        await dispatch('/api/auth/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            resource,
            redirect_uri: redirect,
            code: redirectUrl.searchParams.get('code')!,
            code_verifier: verifier,
          }).toString(),
        }),
        200,
      );
      const { access_token: token } = (await exchanged.json()) as { access_token: string };
      const session = (await status(
        await dispatch('/api/auth/get-session', { headers: { cookie } }),
        200,
      ).json()) as { user: { id: string; email: string; emailVerified: boolean } };
      expect(session.user).toMatchObject({ email, emailVerified: true });
      return { token, cookie, id: session.user.id };
    }

    async function connect(token: string, spoofedAccount: string) {
      const client = new Client({ name: 'worker-integration', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: {
            headers: { authorization: `Bearer ${token}`, 'x-memento-account-id': spoofedAccount },
          },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const response = await runtime!.dispatchFetch(request.url, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              body: request.body ? await request.text() : undefined,
              redirect: 'manual',
            });
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          },
        }),
      );
      return client;
    }

    await reopen();
    expect(await status(await dispatch('/health'), 200).json()).toEqual({ status: 'ok' });
    const noAuth = status(await dispatch('/mcp', { method: 'POST' }), 401);
    expect(noAuth.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(noAuth.headers.get('cache-control')).toBe('no-store');
    expect(noAuth.headers.get('x-content-type-options')).toBe('nosniff');
    status(
      await runtime!.dispatchFetch('https://spoof.invalid/mcp', {
        headers: { 'x-forwarded-host': new URL(origin).host },
      }),
      400,
    );
    status(await dispatch('/mcp', { headers: { origin: 'https://spoof.invalid' } }), 403);
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      expect(
        await status(
          await dispatch(path, {
            headers: { 'x-forwarded-host': 'spoof.invalid', 'x-forwarded-proto': 'http' },
          }),
          200,
        ).json(),
      ).toMatchObject({ resource, authorization_servers: [`${origin}/api/auth`] });
    }
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/oauth-authorization-server',
    ]) {
      expect(await status(await dispatch(path), 200).json()).toMatchObject({
        issuer: `${origin}/api/auth`,
        token_endpoint: `${origin}/api/auth/oauth2/token`,
      });
    }
    for (const path of ['/', '/oauth/app.css', '/oauth/app.js']) {
      expect(status(await dispatch(path), 200).headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
    }
    for (const path of [
      '/import',
      '/_internal/import',
      '/api/auth/importSnapshot',
      '/importDocuments',
    ]) {
      status(await post(path, {}), 404);
    }
    status(
      await dispatch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-host': new URL(origin).host },
        body: JSON.stringify({ provider: 'github' }),
      }),
      403,
    );

    const registration = status(
      await post('/api/auth/oauth2/register', {
        client_name: 'Worker integration',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
      201,
    );
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const owner = await issue(alice, clientId);
    subject = 200;
    const other = await issue(bob, clientId);
    expect(other.id).not.toBe(owner.id);
    status(
      await dispatch('/mcp', {
        method: 'POST',
        headers: { cookie: owner.cookie, 'x-memento-account-id': owner.id },
      }),
      401,
    );
    status(
      await dispatch('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic_fake_token_000000',
          'x-memento-account-id': owner.id,
        },
      }),
      401,
    );
    for (const method of ['GET', 'DELETE']) {
      expect(
        status(
          await dispatch('/mcp', { method, headers: { authorization: `Bearer ${owner.token}` } }),
          405,
        ).headers.get('allow'),
      ).toBe('POST');
    }
    status(
      await dispatch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}` },
        body: 'x'.repeat(1024 * 1024 + 1),
      }),
      413,
    );

    const accountDbs = async () =>
      (await readdir(persistence, { recursive: true })).filter(
        (file) => file.includes('AccountObject') && /[0-9a-f]{64}\.sqlite$/.test(file),
      );
    expect(await accountDbs()).toEqual([]);

    const writer = await connect(owner.token, other.id);
    const dbs = await accountDbs();
    expect(dbs).toHaveLength(1);
    const db = new DatabaseSync(join(persistence, dbs[0]!), { readOnly: true });
    const create = async (title: string, description: string, body: string) => {
      const result = await writer.callTool({
        name: 'create_memory',
        arguments: {
          title,
          description,
          body,
          type: 'other',
          scope: { kind: 'global' },
          provenance: { source: 'user_stated' },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ id: expect.any(String) });
      const { id } = result.structuredContent as { id: string };
      // Check the committed row as soon as the write's response arrives, without another RPC.
      expect(db.prepare('SELECT contents FROM account_documents').all()).toContainEqual({
        contents: expect.stringContaining(`id: ${id}`),
      });
      return id;
    };
    let ids: string[];
    try {
      ids = await Promise.all([
        create(
          'Spacecraft attitude',
          'Use a stable coordinate frame.',
          'Quaternions avoid gimbal lock.',
        ),
        create(
          'Animation interpolation',
          'Blend adjacent keyframes smoothly.',
          'Normalize quaternions after blending.',
        ),
      ]);
      expect(db.prepare('SELECT count(*) AS n FROM account_tool_events').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }

    await reopen();
    const reader = await connect(owner.token, other.id);
    const stranger = await connect(other.token, owner.id);
    for (const id of ids) {
      const found = await reader.callTool({ name: 'get_memory', arguments: { id } });
      expect(found.isError).not.toBe(true);
      expect(found.structuredContent).toMatchObject({ id });
      expect((await stranger.callTool({ name: 'get_memory', arguments: { id } })).isError).toBe(
        true,
      );
    }
    const search = (client: Client) =>
      client.callTool({
        name: 'search_memories',
        arguments: { query: 'quaternions', scope: { kind: 'global' } },
      });
    expect((await search(reader)).structuredContent).toMatchObject({ result_count: 2 });
    expect((await search(stranger)).structuredContent).toMatchObject({ result_count: 0 });
    const grants = (await status(
      await dispatch('/api/auth/oauth2/get-consents', { headers: { cookie: owner.cookie } }),
      200,
    ).json()) as { id: string }[];
    expect(grants).toHaveLength(1);
    status(await post('/oauth/revoke', { id: grants[0]!.id }, other.cookie), 404);
    status(await post('/oauth/revoke', { id: grants[0]!.id }, owner.cookie), 204);
    status(
      await dispatch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}` },
      }),
      401,
    );
    expect((await stranger.listTools()).tools.length).toBeGreaterThan(0);

    // Bypass only the edge check to model a request admitted before revocation.
    const accounts = await runtime!.getDurableObjectNamespace('MEMENTO_ACCOUNTS');
    const target = accounts.get(accounts.idFromName(owner.id)) as unknown as {
      mcp(request: WorkerRequest): Promise<WorkerResponse>;
      importDocuments(documents: unknown): Promise<true>;
    };
    for (const token of [owner.token, other.token]) {
      status(
        await target.mcp(
          new WorkerRequest(resource, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
        401,
      );
    }
    await expect(target.importDocuments([])).rejects.toThrow('already exists');
  } finally {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await runtime?.dispose();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}, 60_000);
