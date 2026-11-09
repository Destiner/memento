import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createAuthService,
  type AuthService,
  type AuthServiceOptions,
} from '../../src/auth/index.js';

const origin = 'https://memory.example';
const email = 'owner@example.test';
const secondEmail = 'second@example.test';
const secret = 'test-only-secret-012345678901234567890123456789';
const resource = `${origin}/mcp`;
const redirect = 'http://127.0.0.1:48731/callback';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let service: AuthService;
let dir: string;
let options: AuthServiceOptions;
let database: DatabaseSync;

function request(
  path: string,
  body?: Record<string, unknown>,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  const machine = /oauth2\/(register|token|revoke)$/.test(path);
  return new Request(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json', ...(!machine ? { origin } : {}) } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function handle(
  path: string,
  body?: Record<string, unknown>,
  cookie?: string,
  headers?: Record<string, string>,
) {
  return service.handle(request(path, body, cookie, headers));
}
function bearer(token: string) {
  return new Request(resource, { headers: { authorization: `Bearer ${token}` } });
}
function seedSession(userEmail = email) {
  const id = randomUUID();
  const sid = randomUUID();
  const token = randomUUID();
  const now = Date.now();
  database
    .prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .run(id, 'Test owner', userEmail, 1, now, now);
  database
    .prepare(
      'INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .run(sid, token, id, now + 86400000, now, now);
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return {
    id,
    cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}
async function register() {
  const r = await handle('/api/auth/oauth2/register', {
    client_name: 'Test client',
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp offline_access',
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { client_id: string };
}
function authorizePath(clientId: string, overrides: Record<string, string> = {}) {
  return `/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, resource, scope: 'mcp offline_access', state: 'test-state', code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent', ...overrides })}`;
}
async function code(clientId: string, cookie: string) {
  const auth = await handle(authorizePath(clientId), undefined, cookie, { accept: 'text/html' });
  expect(auth.status, await auth.clone().text()).toBe(302);
  const location = new URL(auth.headers.get('location')!, origin);
  expect(location.pathname).toBe('/oauth/consent');
  const query = location.search.slice(1);
  const ui = await handle(`${location.pathname}${location.search}`, undefined, cookie);
  expect(ui.status, await ui.clone().text()).toBe(200);
  const consent = await handle(
    '/api/auth/oauth2/consent',
    { accept: true, oauth_query: query },
    cookie,
  );
  expect(consent.status, await consent.clone().text()).toBe(200);
  const result = (await consent.json()) as { url: string };
  const callback = new URL(result.url);
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(callback.searchParams.get('state')).toBe('test-state');
  return callback.searchParams.get('code')!;
}
async function exchange(clientId: string, authCode: string, extra = {}) {
  return handle('/api/auth/oauth2/token', {
    client_id: clientId,
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource,
    ...extra,
  });
}
async function tokens(cookie: string) {
  const client = await register();
  const authCode = await code(client.client_id, cookie);
  const r = await exchange(client.client_id, authCode);
  expect(r.status, await r.clone().text()).toBe(200);
  return {
    ...((await r.json()) as { access_token: string; refresh_token: string }),
    clientId: client.client_id,
    code: authCode,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memento-auth-'));
  options = {
    origin,
    dataDir: dir,
    allowedEmails: [email, secondEmail],
    secret,
    githubClientId: 'test-client',
    githubClientSecret: 'test-secret',
  };
  service = await createAuthService(options);
  database = new DatabaseSync(join(dir, 'auth.sqlite'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  database?.close();
  await service?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('production OAuth boundary', () => {
  it('does not let a slow anonymous body block unrelated authentication', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const pending = service.handle(
      new Request(`${origin}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    try {
      await expect(
        Promise.race([
          service.authenticate(bearer('invalid-but-long-enough-token')),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Authentication blocked by upload')), 200),
          ),
        ]),
      ).resolves.toBeNull();
    } finally {
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
      await pending;
    }
  });

  it('reclaims anonymous registration capacity without deleting approved clients', async () => {
    const owner = seedSession();
    const issued = await tokens(owner.cookie);
    const anon = await register();
    const template = database
      .prepare('SELECT * FROM oauthClient WHERE clientId = ?')
      .get(anon.client_id)!;
    const columns = Object.keys(template);
    const insert = database.prepare(
      `INSERT INTO oauthClient (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    );
    database.exec('BEGIN');
    for (let i = 0; i < 998; i++) {
      const row = { ...template, id: randomUUID(), clientId: randomUUID() };
      insert.run(...columns.map((c) => row[c as keyof typeof row]));
    }
    database.exec('COMMIT');
    await register();
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM oauthClient').get() as { n: number }).n,
    ).toBe(1000);
    expect((await service.authenticate(bearer(issued.access_token)))?.accountId).toBe(owner.id);
  });
  it('preserves offline consent across browser signout while ending session-bound access', async () => {
    const owner = seedSession();
    const issued = await tokens(owner.cookie);
    expect((await handle('/api/auth/sign-out', {}, owner.cookie)).status).toBe(200);
    expect(await service.authenticate(bearer(issued.access_token))).toBeNull();
    const refreshed = await handle('/api/auth/oauth2/token', {
      client_id: issued.clientId,
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
      resource,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect((await service.authenticate(bearer(next.access_token)))?.accountId).toBe(owner.id);
  });
  it('requires explicit providers, secret and an allowlist', async () => {
    await expect(createAuthService({ ...options, allowedEmails: [] })).rejects.toThrow();
    await expect(
      createAuthService({ ...options, githubClientId: undefined, githubClientSecret: undefined }),
    ).rejects.toThrow();
    await expect(createAuthService({ ...options, secret: 'short' })).rejects.toThrow();
    await expect(
      createAuthService({ ...options, origin: 'http://public.example' }),
    ).rejects.toThrow();
  });

  it('publishes discovery and rejects browser CSRF even without cookies', async () => {
    const metadata = (await (
      await handle('/.well-known/oauth-authorization-server/api/auth')
    ).json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(await (await handle('/.well-known/oauth-protected-resource/mcp')).json()).toMatchObject({
      resource,
    });
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, {}]) {
      const r = await service.handle(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: '{"provider":"github"}',
        }),
      );
      expect(r.status).toBe(403);
    }
    expect((await handle('/api/auth/sign-up/email', {})).status).toBe(404);
    expect(
      (
        await handle('/api/auth/sign-in/social', {
          provider: 'github',
          callbackURL: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await handle('/oauth/revoke', { id: 'fake' }, undefined, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
  });

  it('bounds DCR and rejects dangerous redirects, metadata and resources', async () => {
    for (const redirectUri of [
      'http://public.example/callback',
      'javascript:alert(1)',
      'https://user:password@evil.example/callback',
      'https://client.example/cb#fragment',
    ]) {
      expect(
        (await handle('/api/auth/oauth2/register', { redirect_uris: [redirectUri] })).status,
      ).toBe(400);
    }
    expect(
      (
        await handle('/api/auth/oauth2/register', {
          redirect_uris: [redirect],
          resources: ['https://other.example/mcp'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handle('/api/auth/oauth2/register', {
          redirect_uris: [redirect],
          jwks_uri: 'http://127.0.0.1/private',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handle('/api/auth/oauth2/register', {
          redirect_uris: [redirect],
          client_name: 'a'.repeat(17000),
        })
      ).status,
    ).toBe(413);
    await register();
  });

  it('requires authenticated consent, exact resource, S256 and a bearer rather than a browser session', async () => {
    const owner = seedSession();
    expect(await service.authenticate(request('/mcp', undefined, owner.cookie))).toBeNull();
    const client = await register();
    for (const changes of [
      { resource: 'https://other.example/mcp' },
      { code_challenge_method: 'plain' },
      { code_challenge: '' },
      { scope: 'offline_access' },
      { response_type: 'token' },
    ]) {
      expect(
        (await handle(authorizePath(client.client_id, changes), undefined, owner.cookie)).status,
      ).toBe(400);
    }
    expect(
      (await handle('/api/auth/oauth2/consent', { accept: true, oauth_query: 'bad' })).status,
    ).toBe(401);
    const t = await tokens(owner.cookie);
    expect(await service.authenticate(bearer(t.access_token))).toEqual({
      accountId: owner.id,
      email,
    });
    expect(owner.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await service.authenticate(bearer(t.refresh_token))).toBeNull();
    const stored = database.prepare('SELECT token FROM oauthAccessToken').get() as {
      token: string;
    };
    expect(stored.token).not.toBe(t.access_token);
    expect(stored.token).toBe(createHash('sha256').update(t.access_token).digest('base64url'));
  });

  it('isolates identities, persists tokens and rechecks current verified allowlist authority', async () => {
    const a = seedSession();
    const b = seedSession(secondEmail);
    const at = await tokens(a.cookie);
    const bt = await tokens(b.cookie);
    expect((await service.authenticate(bearer(at.access_token)))?.accountId).toBe(a.id);
    expect((await service.authenticate(bearer(bt.access_token)))?.accountId).toBe(b.id);
    const consent = database.prepare('SELECT id FROM oauthConsent WHERE userId = ?').get(a.id) as {
      id: string;
    };
    expect((await handle('/oauth/revoke', { id: consent.id }, b.cookie)).status).toBe(404);
    await service.close();
    service = await createAuthService(options);
    expect((await service.authenticate(bearer(at.access_token)))?.accountId).toBe(a.id);
    await service.close();
    service = await createAuthService({ ...options, allowedEmails: [secondEmail] });
    expect(await service.authenticate(bearer(at.access_token))).toBeNull();
    expect((await service.authenticate(bearer(bt.access_token)))?.accountId).toBe(b.id);
    database.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(b.id);
    expect(await service.authenticate(bearer(bt.access_token))).toBeNull();
  });

  it('binds a shared client authorization to the consenting user, never the client owner', async () => {
    const a = seedSession();
    const b = seedSession(secondEmail);
    const client = await register();
    database
      .prepare('UPDATE oauthClient SET userId = ? WHERE clientId = ?')
      .run(b.id, client.client_id);
    const ar = await exchange(client.client_id, await code(client.client_id, a.cookie));
    const br = await exchange(client.client_id, await code(client.client_id, b.cookie));
    expect(ar.status).toBe(200);
    expect(br.status).toBe(200);
    const at = (await ar.json()) as { access_token: string };
    const bt = (await br.json()) as { access_token: string };
    expect((await service.authenticate(bearer(at.access_token)))?.accountId).toBe(a.id);
    expect((await service.authenticate(bearer(bt.access_token)))?.accountId).toBe(b.id);
    const consent = database
      .prepare('SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ?')
      .get(a.id, client.client_id) as { id: string };
    expect((await handle('/oauth/revoke', { id: consent.id }, a.cookie)).status).toBe(204);
    expect(await service.authenticate(bearer(at.access_token))).toBeNull();
    expect((await service.authenticate(bearer(bt.access_token)))?.accountId).toBe(b.id);
  });

  it('limits unauthenticated registration attempts independently of caller-supplied IP headers', async () => {
    for (let i = 0; i < 20; i++) await register();
    const r = await handle('/api/auth/oauth2/register', { redirect_uris: [redirect] }, undefined, {
      'x-forwarded-for': '192.0.2.100',
    });
    expect(r.status).toBe(429);
  });

  it('rejects PKCE mismatch, code replay and wrong token audience', async () => {
    const owner = seedSession();
    const client = await register();
    const c = await code(client.client_id, owner.cookie);
    expect((await exchange(client.client_id, c, { code_verifier: 'w'.repeat(64) })).status).toBe(
      400,
    );
    const t = await tokens(owner.cookie);
    expect((await exchange(t.clientId, t.code)).status).toBe(400);
    expect(await service.authenticate(bearer(t.access_token))).toBeNull();
    const t2 = await tokens(owner.cookie);
    database
      .prepare('UPDATE oauthAccessToken SET resources = ? WHERE token = ?')
      .run(
        JSON.stringify(['https://other.example/mcp']),
        createHash('sha256').update(t2.access_token).digest('base64url'),
      );
    expect(await service.authenticate(bearer(t2.access_token))).toBeNull();
  });

  it('rejects expired codes and refresh tokens, and validates token resource without consuming the code', async () => {
    const owner = seedSession();
    const client = await register();
    const c = await code(client.client_id, owner.cookie);
    expect((await exchange(client.client_id, c, { resource: `${origin}/other` })).status).toBe(400);
    const valid = await exchange(client.client_id, c);
    expect(valid.status).toBe(200);
    const c2 = await code(client.client_id, owner.cookie);
    database
      .prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?')
      .run(Date.now() - 1000, createHash('sha256').update(c2).digest('base64url'));
    expect((await exchange(client.client_id, c2)).status).toBe(400);
    const t = await tokens(owner.cookie);
    database.prepare('UPDATE oauthRefreshToken SET expiresAt = ?').run(Date.now() - 1000);
    expect(
      (
        await handle('/api/auth/oauth2/token', {
          grant_type: 'refresh_token',
          client_id: t.clientId,
          refresh_token: t.refresh_token,
          resource,
        })
      ).status,
    ).toBe(400);
  });

  it('revokes outstanding authorization codes and machine-revoked access tokens live', async () => {
    const owner = seedSession();
    const t = await tokens(owner.cookie);
    expect(
      (
        await handle('/api/auth/oauth2/revoke', {
          client_id: t.clientId,
          token: t.access_token,
          token_type_hint: 'access_token',
        })
      ).status,
    ).toBe(200);
    expect(await service.authenticate(bearer(t.access_token))).toBeNull();
    const c = await code(t.clientId, owner.cookie);
    const consent = database
      .prepare('SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ?')
      .get(owner.id, t.clientId) as { id: string };
    expect((await handle('/oauth/revoke', { id: consent.id }, owner.cookie)).status).toBe(204);
    // Re-consenting must not bring a pre-revocation code back to life.
    await code(t.clientId, owner.cookie);
    expect((await exchange(t.clientId, c)).status).toBe(400);
  });

  it('serializes concurrent refresh replay and refuses token issuance after email admission is removed', async () => {
    const owner = seedSession();
    const t = await tokens(owner.cookie);
    const refresh = () =>
      handle('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        client_id: t.clientId,
        refresh_token: t.refresh_token,
        resource,
      });
    const responses = await Promise.all([refresh(), refresh()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const result = (await responses.find((r) => r.status === 200)!.json()) as {
      access_token: string;
    };
    expect(await service.authenticate(bearer(result.access_token))).toBeNull();
    const t2 = await tokens(owner.cookie);
    await service.close();
    service = await createAuthService({ ...options, allowedEmails: [secondEmail] });
    const denied = await handle('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: t2.clientId,
      refresh_token: t2.refresh_token,
      resource,
    });
    expect(denied.status).toBe(403);
  });

  it('enforces expiry and live revocation; rotates refresh tokens and fences replay', async () => {
    const owner = seedSession();
    const t = await tokens(owner.cookie);
    const refreshed = await handle('/api/auth/oauth2/token', {
      client_id: t.clientId,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      resource,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect((await service.authenticate(bearer(next.access_token)))?.accountId).toBe(owner.id);
    expect(
      (
        await handle('/api/auth/oauth2/token', {
          client_id: t.clientId,
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
          resource,
        })
      ).status,
    ).toBe(400);
    expect(await service.authenticate(bearer(next.access_token))).toBeNull();
    const t2 = await tokens(owner.cookie);
    database.prepare('UPDATE oauthAccessToken SET expiresAt = ?').run(Date.now() - 1);
    expect(await service.authenticate(bearer(t2.access_token))).toBeNull();
    const t3 = await tokens(owner.cookie);
    const consent = database
      .prepare('SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ?')
      .get(owner.id, t3.clientId) as { id: string };
    expect((await handle('/oauth/revoke', { id: consent.id }, owner.cookie)).status).toBe(204);
    expect(await service.authenticate(bearer(t3.access_token))).toBeNull();
    expect(
      (
        await handle('/api/auth/oauth2/token', {
          client_id: t3.clientId,
          grant_type: 'refresh_token',
          refresh_token: t3.refresh_token,
          resource,
        })
      ).status,
    ).toBe(400);
    expect((await handle('/api/auth/sign-out', {}, owner.cookie)).status).toBe(200);
    expect((await handle('/oauth/consent', undefined, owner.cookie)).status).toBe(401);
  });
});
