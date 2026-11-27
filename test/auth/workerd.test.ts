import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { expect, it } from 'vitest';

const origin = 'https://memory.example';
const email = 'owner@example.test';
const googleEmail = 'google-owner@example.test';
const resource = `${origin}/mcp`;
const redirect = 'http://127.0.0.1:49111/callback';
const verifier = 'v'.repeat(64);
const authOptions = {
  origin,
  allowedEmails: [email, googleEmail],
  secret: 'workerd-test-only-012345678901234567890123456789',
  googleClientId: 'mock-google-client',
  googleClientSecret: 'mock-google-secret',
  githubClientId: 'mock-github-client',
  githubClientSecret: 'mock-github-secret',
};

type Tokens = { access_token: string; refresh_token: string };

function status(response: WorkerResponse, expected: number) {
  expect(response.status).toBe(expected);
  return response;
}

function cookies(response: WorkerResponse) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

it('migrates SQLite in workerd, verifies both providers, and persists OAuth grants and revocation', async () => {
  const keys = await generateKeyPair('RS256');
  const googleKey = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'mock-key',
    alg: 'RS256',
    use: 'sig',
  };
  const googleToken = () =>
    new SignJWT({
      sub: googleSubject,
      name: 'Mock Google owner',
      email: googleEmail,
      email_verified: verified,
    })
      .setProtectedHeader({ alg: 'RS256', kid: googleKey.kid })
      .setIssuer('https://accounts.google.com')
      .setAudience(authOptions.googleClientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  let verified = false;
  let googleSubject = 'mock-google-subject';
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./workerd.fixture.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    conditions: ['workerd', 'worker'],
    external: ['cloudflare:*', 'node:*'],
  });
  const dir = await mkdtemp(join(tmpdir(), 'memento-auth-workerd-'));
  const githubCalls: string[] = [];
  let worker: Miniflare | undefined;

  async function reopen() {
    await worker?.dispose();
    const name = 'memento-auth-test';
    worker = new Miniflare({
      host: '127.0.0.1',
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: dir,
      workers: [
        {
          config: {
            name,
            compatibilityDate: '2026-11-23',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'fixture.mjs',
              modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0]!.text } },
            },
            env: {
              AUTH: { type: 'durable-object', worker: name, exportName: 'AuthFixture' },
              AUTH_OPTIONS: { type: 'json', value: authOptions },
            },
            exports: { AuthFixture: { type: 'durable-object', storage: 'sqlite' } },
          },
          dev: {
            outboundService: {
              type: 'fetcher',
              async handler(request) {
                const url = new URL(request.url);
                const call = `${request.method} ${url.origin}${url.pathname}`;
                if (['https://github.com', 'https://api.github.com'].includes(url.origin))
                  githubCalls.push(call);
                switch (call) {
                  case 'POST https://oauth2.googleapis.com/token':
                    return WorkerResponse.json({
                      id_token: await googleToken(),
                      access_token: 'mock-google-provider-token',
                      token_type: 'bearer',
                    });
                  case 'GET https://www.googleapis.com/oauth2/v3/certs':
                    return WorkerResponse.json({ keys: [googleKey] });
                  case 'POST https://github.com/login/oauth/access_token':
                    return WorkerResponse.json({
                      access_token: 'mock-provider-token',
                      token_type: 'bearer',
                      scope: 'read:user,user:email',
                    });
                  case 'GET https://api.github.com/user':
                    return WorkerResponse.json({ id: 100, login: 'mock-user', name: 'Mock owner' });
                  case 'GET https://api.github.com/user/emails':
                    return WorkerResponse.json([{ email, verified: true, primary: true }]);
                  default:
                    return new WorkerResponse(`Unexpected outbound request: ${call}`, {
                      status: 502,
                    });
                }
              },
            },
          },
        },
      ],
    });
  }

  function fetch(path: string, init?: Parameters<Miniflare['dispatchFetch']>[1]) {
    return worker!.dispatchFetch(`${origin}${path}`, { ...init, redirect: 'manual' });
  }

  function post(path: string, body: Record<string, unknown>, cookie?: string) {
    return fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(path === '/api/auth/oauth2/register' ? {} : { origin }),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function tokenRequest(params: Record<string, string>) {
    return fetch('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ resource, ...params }),
    });
  }

  async function identity(accessToken: string) {
    const response = await status(
      await fetch('/mcp', { headers: { authorization: `Bearer ${accessToken}` } }),
      200,
    );
    return response.json();
  }

  try {
    await reopen();
    const committed = [{ value: 'commit-after' }, { value: 'commit-before' }];
    expect(
      await status(await fetch('/test/sql-transaction', { method: 'POST' }), 200).json(),
    ).toEqual(committed);

    const registerClient = (name: string) =>
      post('/api/auth/oauth2/register', {
        client_name: name,
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    status(await registerClient('Aborted registration'), 500);
    expect(await status(await fetch('/test/registrations'), 200).json()).toEqual([]);
    const register = status(await registerClient('Workerd test client'), 201);
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect,
      resource,
      scope: 'mcp offline_access',
      state: 'workerd-test-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    // The Miniflare bridge otherwise sends Undici's default sec-fetch-mode: cors.
    const authorize = (params: URLSearchParams) =>
      fetch(`/api/auth/oauth2/authorize?${params}`, {
        headers: { accept: 'text/html', 'MF-Sec-Fetch-Mode': 'navigate' },
      });
    const missingChallenge = new URLSearchParams(query);
    missingChallenge.delete('code_challenge');
    await status(await authorize(missingChallenge), 400);

    const authorization = await status(await authorize(query), 302);
    const login = new URL(authorization.headers.get('location')!, origin);
    expect(login.pathname).toBe('/oauth/login');
    const start = await status(
      await post('/api/auth/sign-in/social', {
        provider: 'github',
        oauth_query: login.search.slice(1),
      }),
      200,
    );
    const provider = new URL(((await start.json()) as { url: string }).url);
    expect(provider.origin).toBe('https://github.com');
    const providerState = provider.searchParams.get('state');
    expect(providerState).toBeTruthy();
    const callbackQuery = new URLSearchParams({ code: 'mock-code', state: providerState! });
    const callback = await status(
      await fetch(`/api/auth/callback/github?${callbackQuery}`, {
        headers: { cookie: cookies(start), accept: 'text/html', 'MF-Sec-Fetch-Mode': 'navigate' },
      }),
      302,
    );
    const consent = new URL(callback.headers.get('location')!, origin);
    expect(consent.searchParams.getAll('error')).toEqual([]);
    expect(githubCalls).toEqual([
      'POST https://github.com/login/oauth/access_token',
      'GET https://api.github.com/user',
      'GET https://api.github.com/user/emails',
    ]);
    expect(consent.pathname).toBe('/oauth/consent');
    const cookie = cookies(callback);
    expect(cookie).toContain('session_token');
    const consentPage = await status(
      await fetch(`${consent.pathname}${consent.search}`, {
        headers: { cookie },
      }),
      200,
    );
    expect(await consentPage.text()).toContain(email);

    const approval = await status(
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
    const clientCallback = new URL(((await approval.json()) as { url: string }).url);
    expect(clientCallback.origin + clientCallback.pathname).toBe(redirect);
    expect(clientCallback.searchParams.get('state')).toBe(query.get('state'));
    const code = clientCallback.searchParams.get('code');
    expect(code).toBeTruthy();
    const exchange = await status(
      await tokenRequest({
        client_id: clientId,
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      200,
    );
    const issued = (await exchange.json()) as Tokens;
    const owner = await identity(issued.access_token);
    expect(owner).toEqual({
      email,
      accountId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    const browserOnly = await status(await fetch('/mcp', { headers: { cookie } }), 200);
    expect(await browserOnly.json()).toBeNull();

    async function signInWithGoogle() {
      const start = status(await post('/api/auth/sign-in/social', { provider: 'google' }), 200);
      const provider = new URL(((await start.json()) as { url: string }).url);
      expect(provider.origin).toBe('https://accounts.google.com');
      const parameters = new URLSearchParams({
        code: 'mock-code',
        state: provider.searchParams.get('state')!,
      });
      const callback = status(
        await fetch(`/api/auth/callback/google?${parameters}`, {
          headers: { cookie: cookies(start), accept: 'text/html', 'MF-Sec-Fetch-Mode': 'navigate' },
        }),
        302,
      );
      return {
        cookie: cookies(callback),
        location: new URL(callback.headers.get('location')!, origin),
      };
    }

    const rejectedGoogle = await signInWithGoogle();
    expect(rejectedGoogle.location.searchParams.has('error')).toBe(true);
    expect(rejectedGoogle.cookie.includes('session_token')).toBe(false);
    verified = true;
    googleSubject = 'mock-aborted-google-subject';
    const abortedGoogle = await signInWithGoogle();
    expect(abortedGoogle.location.searchParams.has('error')).toBe(true);
    expect(abortedGoogle.cookie.includes('session_token')).toBe(false);
    // If the failed account insert left a user behind, implicit linking would reject this login.
    googleSubject = 'mock-google-subject';
    const googleLogin = await signInWithGoogle();
    expect(googleLogin.location.searchParams.getAll('error')).toEqual([]);
    const googleSession = (await status(
      await fetch('/api/auth/get-session', { headers: { cookie: googleLogin.cookie } }),
      200,
    ).json()) as { user: { id: string; email: string; emailVerified: boolean } };
    expect(googleSession.user).toMatchObject({ email: googleEmail, emailVerified: true });
    expect(googleSession.user.id).not.toBe((owner as { accountId: string }).accountId);

    // Stop workerd itself, not just the test fixture, while keeping SQLite files.
    await reopen();
    expect(await status(await fetch('/test/sql-transaction'), 200).json()).toEqual(committed);
    expect(await identity(issued.access_token)).toEqual(owner);
    status(await registerClient('Stale unused'), 201);
    status(await registerClient('Stale numeric'), 201);
    status(await registerClient('Fresh unused'), 201);
    status(await fetch('/test/registrations', { method: 'POST' }), 200);
    status(await registerClient('New unused'), 201);
    expect(await status(await fetch('/test/registrations'), 200).json()).toEqual([
      { name: 'Fresh unused' },
      { name: 'New unused' },
      { name: 'Workerd test client' },
    ]);
    const refresh = (token: string) =>
      tokenRequest({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token,
      });
    const refreshed = (await (
      await status(await refresh(issued.refresh_token), 200)
    ).json()) as Tokens;
    expect(refreshed.refresh_token).toEqual(expect.any(String));
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
    expect(await identity(refreshed.access_token)).toEqual(owner);

    async function getConsents() {
      const response = await status(
        await fetch('/api/auth/oauth2/get-consents', { headers: { cookie } }),
        200,
      );
      return (await response.json()) as { id: string; clientId: string }[];
    }

    const records = await getConsents();
    expect(records).toEqual([expect.objectContaining({ clientId, id: expect.any(String) })]);
    await status(await post('/oauth/revoke', { id: records[0]!.id }, cookie), 204);
    expect(await identity(refreshed.access_token)).toBeNull();

    await reopen();
    expect(await getConsents()).toEqual([]);
    expect(await identity(issued.access_token)).toBeNull();
    expect(await identity(refreshed.access_token)).toBeNull();
    await status(await refresh(refreshed.refresh_token), 400);
  } finally {
    try {
      await worker?.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 30_000);
