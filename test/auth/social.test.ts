import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createAuthService, type AuthService } from '../../src/auth/index.js';
import { githubProvider } from '../../src/auth/social.js';

const origin = 'https://memory.example';
const email = 'owner@example.test';
let service: AuthService;
let dir: string;
let db: DatabaseSync;
let verified = true;
let selectedEmail = email;
let subject = 100;
let calls: string[];
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memento-social-'));
  service = await createAuthService({
    origin,
    dataDir: dir,
    allowedEmails: [email, 'second@example.test'],
    secret: 'test-only-secret-012345678901234567890123456789',
    githubClientId: 'test-client',
    githubClientSecret: 'test-secret',
  });
  db = new DatabaseSync(join(dir, 'auth.sqlite'));
  verified = true;
  selectedEmail = email;
  subject = 100;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json({
          access_token: 'mock-provider-token',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      if (url === 'https://api.github.com/user')
        return Response.json({ id: subject, login: 'test-user', name: 'Test owner' });
      if (url === 'https://api.github.com/user/emails')
        return Response.json([{ email: selectedEmail, verified, primary: true }]);
      throw new Error(`Unexpected network request: ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

async function signIn(oauthQuery?: string) {
  const start = await service.handle(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
      }),
    }),
  );
  expect(start.status, await start.clone().text()).toBe(200);
  const data = (await start.json()) as { url: string };
  const providerUrl = new URL(data.url);
  expect(providerUrl.origin).toBe('https://github.com');
  const callback = await service.handle(
    new Request(
      `${origin}/api/auth/callback/github?code=mock-code&state=${providerUrl.searchParams.get('state')}`,
      { headers: { cookie: cookies(start), accept: 'text/html' } },
    ),
  );
  return { callback, start, providerUrl };
}

it('runs real social callback admission, then OAuth authorization/consent/token exchange without real credentials', async () => {
  const redirectUri = 'http://localhost:49111/callback';
  const register = await service.handle(
    new Request(`${origin}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Mock MCP',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
  expect(register.status).toBe(201);
  const client = (await register.json()) as { client_id: string };
  const verifier = 'v'.repeat(64);
  const params = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource: `${origin}/mcp`,
    scope: 'mcp offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'mock-state',
  });
  const authorize = await service.handle(
    new Request(`${origin}/api/auth/oauth2/authorize?${params}`, {
      headers: { accept: 'text/html' },
    }),
  );
  expect(authorize.status).toBe(302);
  const login = new URL(authorize.headers.get('location')!, origin);
  expect(login.pathname).toBe('/oauth/login');
  const { callback } = await signIn(login.search.slice(1));
  expect(callback.status, await callback.clone().text()).toBe(302);
  const consentPage = new URL(callback.headers.get('location')!, origin);
  expect(consentPage.pathname).toBe('/oauth/consent');
  const cookie = cookies(callback);
  expect(cookie).toContain('session_token');
  const consent = await service.handle(
    new Request(`${origin}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
    }),
  );
  expect(consent.status, await consent.clone().text()).toBe(200);
  const result = (await consent.json()) as { url: string };
  const exchange = await service.handle(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: 'authorization_code',
        code: new URL(result.url).searchParams.get('code')!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    }),
  );
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  const token = (await exchange.json()) as { access_token: string };
  const identity = await service.authenticate(
    new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${token.access_token}` } }),
  );
  expect(identity?.email).toBe(email);
  expect(identity?.accountId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const account = db
    .prepare('SELECT accountId, userId, accessToken, refreshToken, idToken FROM account')
    .get() as Record<string, unknown>;
  expect(account.accountId).toBe('100');
  expect(account.userId).toBe(identity?.accountId);
  expect(account).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
  expect(calls).toContain('https://api.github.com/user/emails');
});

it.each(['unverified', 'not-allowed'] as const)(
  'refuses %s social email and creates no account or session',
  async (mode) => {
    if (mode === 'unverified') verified = false;
    else selectedEmail = 'outsider@example.test';
    const { callback } = await signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('error');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toMatchObject({ n: 0 });
  },
);

it('does not implicitly link a second social subject to an existing email', async () => {
  const first = await signIn();
  expect(cookies(first.callback)).toContain('session_token');
  subject = 200;
  const second = await signIn();
  expect(cookies(second.callback)).not.toContain('session_token');
  expect(db.prepare('SELECT COUNT(*) AS n FROM account').get()).toMatchObject({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toMatchObject({ n: 1 });
  selectedEmail = 'second@example.test';
  const distinct = await signIn();
  expect(cookies(distinct.callback)).toContain('session_token');
  const users = db.prepare('SELECT id FROM user').all() as { id: string }[];
  expect(users).toHaveLength(2);
  expect(users[0]!.id).not.toBe(users[1]!.id);
});

it('fails closed if the verified email API fails, and rejects callback state replay', async () => {
  const { callback, start, providerUrl } = await signIn();
  expect(cookies(callback)).toContain('session_token');
  const replay = await service.handle(
    new Request(
      `${origin}/api/auth/callback/github?code=mock-code&state=${providerUrl.searchParams.get('state')}`,
      { headers: { cookie: cookies(start) } },
    ),
  );
  expect(cookies(replay)).not.toContain('session_token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  const provider = githubProvider('test-client', 'test-secret', new Set([email]));
  expect(
    await provider.getUserInfo!({ accessToken: 'mock-provider-token', tokenType: 'bearer' }),
  ).toBeNull();
});
