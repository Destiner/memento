import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { googleProvider } from '../../src/auth/social.js';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'mock-google-key', alg: 'RS256', use: 'sig' };
});
afterEach(() => vi.unstubAllGlobals());

it('verifies Google signature, issuer, audience, expiry and verified allowlisted email against mocked JWKS', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(String(url)).toBe('https://www.googleapis.com/oauth2/v3/certs');
      return Response.json({ keys: [jwk] });
    }),
  );
  const provider = googleProvider(
    'mock-client-id',
    'mock-client-secret',
    new Set(['owner@example.test']),
  );
  async function token(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey) {
    return new SignJWT({
      sub: 'stable-google-subject',
      name: 'Test owner',
      email: 'owner@example.test',
      email_verified: true,
      iss: 'https://accounts.google.com',
      aud: 'mock-client-id',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-google-key' })
      .sign(privateKey);
  }
  const good = await provider.getUserInfo({ idToken: await token() });
  expect(good?.user).toMatchObject({ email: 'owner@example.test', emailVerified: true });
  for (const overrides of [
    { email_verified: false },
    { email: 'outsider@example.test' },
    { aud: 'wrong-client' },
    { iss: 'https://evil.example' },
    { exp: 1 },
  ]) {
    expect(await provider.getUserInfo({ idToken: await token(overrides) })).toBeNull();
  }
  const wrongKey = await generateKeyPair('RS256');
  expect(await provider.getUserInfo({ idToken: await token({}, wrongKey.privateKey) })).toBeNull();
  expect(await provider.getUserInfo({})).toBeNull();
});
