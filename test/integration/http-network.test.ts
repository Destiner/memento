import { serve } from '@hono/node-server';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'vitest';
import { AccountStores } from '../../src/accounts.js';
import { createAuthService } from '../../src/auth/index.js';
import { createApplication } from '../../src/http.js';

test('real Node HTTP: OAuth, SDK tool call, service reopen and live revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memento-network-'));
  let application: ReturnType<typeof createApplication> | undefined;
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => application?.fetch(request) ?? new Response(null, { status: 503 }),
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const origin = `http://127.0.0.1:${address.port}`;
  const resource = `${origin}/mcp`;
  const secret = 'test-only-network-auth-secret-0000000000000';
  const options = {
    origin,
    dataDir: dir,
    allowedEmails: ['test@example.test'],
    secret,
    githubClientId: 'test-client',
    githubClientSecret: 'test-secret',
  };
  let auth = await createAuthService(options);
  let accounts = new AccountStores(dir);
  application = createApplication({ origin, auth, accounts });
  const db = new DatabaseSync(join(dir, 'auth.sqlite'));
  const client = new Client({ name: 'network-acceptance', version: '1' });
  try {
    const userId = randomUUID();
    const sessionToken = randomUUID();
    const now = Date.now();
    db.prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    ).run(userId, 'Fixture', 'test@example.test', 1, now, now);
    db.prepare(
      'INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    ).run(randomUUID(), sessionToken, userId, now + 86400000, now, now);
    const cookie = `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${createHmac('sha256', secret).update(sessionToken).digest('base64')}`)}`;
    const post = (path: string, body: Record<string, unknown>, browser = false) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(browser ? { origin, cookie } : {}) },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
    const redirect = 'http://127.0.0.1:44444/callback';
    const registration = await post('/api/auth/oauth2/register', {
      client_name: 'Network fixture',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp offline_access',
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const verifier = 'v'.repeat(64);
    const authorize = await fetch(
      `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', resource, scope: 'mcp offline_access', state: 'fixture-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' })}`,
      { headers: { cookie, accept: 'text/html' }, redirect: 'manual' },
    );
    // Node fetch advertises cors mode; the provider returns a redirect instruction.
    expect(authorize.status).toBe(200);
    const consentURL = new URL(((await authorize.json()) as { url: string }).url, origin);
    const consent = await post(
      '/api/auth/oauth2/consent',
      { accept: true, oauth_query: consentURL.search.slice(1) },
      true,
    );
    expect(consent.status).toBe(200);
    const callback = new URL(((await consent.json()) as { url: string }).url);
    const exchanged = await post('/api/auth/oauth2/token', {
      client_id: clientId,
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: redirect,
      resource,
    });
    expect(exchanged.status).toBe(200);
    const { access_token: token } = (await exchanged.json()) as { access_token: string };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const created = await client.callTool({
      name: 'create_project',
      arguments: { name: 'Network fixture', description: 'Synthetic HTTP acceptance fixture.' },
    });
    expect(created.isError).not.toBe(true);
    const id = created.structuredContent?.id;
    await application.drain();
    await accounts.close();
    await auth.close();
    auth = await createAuthService(options);
    accounts = new AccountStores(dir);
    application = createApplication({ origin, auth, accounts });
    const found = await client.callTool({
      name: 'resolve_project',
      arguments: { name_hint: 'Network fixture' },
    });
    expect((found.structuredContent?.project as { id: string }).id).toBe(id);
    const row = db.prepare('SELECT id FROM oauthConsent WHERE userId = ?').get(userId) as {
      id: string;
    };
    expect((await post('/oauth/revoke', { id: row.id }, true)).status).toBe(204);
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
    await application?.drain();
    await accounts.close();
    await auth.close();
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
