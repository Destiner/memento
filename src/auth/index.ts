import { randomUUID, createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { oauthProvider, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { githubProvider, googleProvider } from './social.js';
import { escapeHtml, page, script, style } from './ui.js';
import { BodyLimitError, bufferRequest } from '../request-body.js';

export interface AuthServiceOptions {
  origin: string;
  dataDir: string;
  allowedEmails: string[];
  secret: string;
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
}
export interface AuthIdentity {
  accountId: string;
  email: string;
}
export interface AuthService {
  handle(request: Request): Promise<Response>;
  authenticate(request: Request): Promise<AuthIdentity | null>;
  close(): Promise<void>;
}

class InvalidRequest extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const fail = (status: number, error = 'invalid_request') => Response.json({ error }, { status });
const sameOrigin = (request: Request, origin: string) => {
  if (request.headers.has('origin')) return request.headers.get('origin') === origin;
  try {
    return new URL(request.headers.get('referer') ?? '').origin === origin;
  } catch {
    return false;
  }
};
const scopesValid = (value: unknown) =>
  typeof value === 'string' &&
  value.split(' ').includes('mcp') &&
  value.split(' ').every((s) => ['mcp', 'offline_access'].includes(s));

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 16384) {
          await reader.cancel();
          throw new InvalidRequest('body_limit');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  const text = Buffer.concat(chunks).toString();
  let value: unknown;
  if (request.headers.get('content-type')?.split(';')[0] === 'application/json')
    value = JSON.parse(text);
  else {
    const p = new URLSearchParams(text);
    if ([...p.keys()].some((k) => p.getAll(k).length !== 1))
      throw new InvalidRequest('duplicate_parameter');
    value = Object.fromEntries(p);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidRequest('invalid_body');
  return value as Record<string, unknown>;
}
function withBody(request: Request, body: Record<string, unknown>) {
  const headers = new Headers(request.headers);
  const form = /\/oauth2\/(token|revoke)$/.test(new URL(request.url).pathname);
  headers.set('content-type', form ? 'application/x-www-form-urlencoded' : 'application/json');
  headers.delete('content-length');
  if (form && Object.values(body).some((v) => typeof v !== 'string'))
    throw new InvalidRequest('invalid_body');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: form
      ? new URLSearchParams(body as Record<string, string>).toString()
      : JSON.stringify(body),
  });
}
function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const { origin, dataDir, secret } = options;
  const base = new URL(origin);
  if (
    base.origin !== origin ||
    !(
      base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    ) ||
    secret.length < 32
  )
    throw new Error('Invalid auth configuration');
  const allowed = new Set(options.allowedEmails.map((e) => e.trim().toLowerCase()));
  if (!allowed.size || [...allowed].some((e) => !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(e)))
    throw new Error('A nonempty email allowlist is required');
  for (const [id, key] of [
    [options.googleClientId, options.googleClientSecret],
    [options.githubClientId, options.githubClientSecret],
  ]) {
    if (Boolean(id) !== Boolean(key)) throw new Error('Incomplete social provider configuration');
  }
  if (!options.googleClientId && !options.githubClientId)
    throw new Error('At least one social provider is required');
  const resource = `${origin}/mcp`;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'auth.sqlite');
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const plugin = oauthProvider({
    loginPage: '/oauth/login',
    consentPage: '/oauth/consent',
    disableJwtPlugin: true,
    scopes: ['mcp', 'offline_access'],
    grantTypes: ['authorization_code', 'refresh_token'],
    storeTokens: { hash },
    storeClientSecret: 'encrypted',
    accessTokenExpiresIn: 300,
    refreshTokenExpiresIn: 30 * 86400,
    codeExpiresIn: 60,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    clientRegistrationDefaultApplicationType: 'infer',
    clientRegistrationDefaultScopes: ['mcp', 'offline_access'],
    resources: [resource],
    clientRegistrationDefaultResources: [resource],
    clientRegistrationAllowedResources: [resource],
    enforcePerClientResources: true,
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
    customAccessTokenClaims: ({ user }) => {
      if (!user?.emailVerified || !allowed.has(user.email) || !uuid.test(user.id))
        throw new APIError('FORBIDDEN', { error: 'access_denied' });
      return {};
    },
  });
  const discarded = {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
  const config = {
    appName: 'Memento',
    baseURL: origin,
    basePath: '/api/auth',
    secret,
    database: db,
    plugins: [plugin],
    trustedOrigins: [origin],
    logger: { disabled: true },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(options.googleClientId
        ? { google: googleProvider(options.googleClientId, options.googleClientSecret!, allowed) }
        : {}),
      ...(options.githubClientId
        ? { github: githubProvider(options.githubClientId, options.githubClientSecret!, allowed) }
        : {}),
    },
    user: {
      validateUserInfo({ user, source }) {
        const profile = source.oauth?.profile;
        if (
          source.method !== 'oauth' ||
          !['google', 'github'].includes(source.oauth?.providerId ?? '') ||
          profile?.email_verified !== true ||
          typeof profile.email !== 'string' ||
          !allowed.has(profile.email.toLowerCase()) ||
          user.email !== profile.email.toLowerCase() ||
          user.emailVerified !== true
        )
          return { error: 'sign_in_failed' };
      },
    },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
    },
    session: { cookieCache: { enabled: false } },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: base.protocol === 'https:',
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...discarded } }) },
        update: { before: async (account) => ({ data: { ...account, ...discarded } }) },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        ctx.context.trustedOrigins = [origin];
        if (ctx.path === '/sign-in/social') {
          const body = ctx.body as Record<string, unknown>;
          if (
            !body ||
            !['google', 'github'].includes(String(body.provider)) ||
            Object.keys(body).some((k) => !['provider', 'oauth_query'].includes(k))
          )
            throw new APIError('BAD_REQUEST');
          return {
            context: {
              body: {
                ...body,
                callbackURL: `${origin}/`,
                errorCallbackURL: `${origin}/?error=sign_in_failed`,
                disableRedirect: true,
              },
            },
          };
        }
      }),
    },
    onAPIError: { errorURL: `${origin}/?error=sign_in_failed` },
  } satisfies BetterAuthOptions;
  try {
    // Init seeds resources; the schema must exist before plugin initialization.
    const migrations = await getMigrations(config);
    await migrations.runMigrations();
    const auth = betterAuth(config);
    const context = await auth.$context;
    const adapter = context.adapter;
    let closed = false;
    let registrationWindow = Date.now();
    let registrations = 0;
    let queue: Promise<unknown> = Promise.resolve();
    // Serialize rotations, replay cleanup and revocation within this SQLite owner.
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = queue.then(() => {
        if (closed) throw new Error('Auth service closed');
        return fn();
      });
      queue = next.catch(() => undefined);
      return next;
    };
    const sessionFor = async (request: Request) => {
      const s = await auth.api.getSession({ headers: request.headers });
      return s && s.user.emailVerified && allowed.has(s.user.email) && uuid.test(s.user.id)
        ? s
        : null;
    };
    const authenticate = async (request: Request): Promise<AuthIdentity | null> => {
      const match = /^Bearer ([A-Za-z0-9_-]{20,512})$/i.exec(
        request.headers.get('authorization') ?? '',
      );
      if (!match) return null;
      const token = await adapter.findOne<Record<string, unknown>>({
        model: 'oauthAccessToken',
        where: [{ field: 'token', value: hash(match[1]!) }],
      });
      if (
        !token ||
        token.revoked ||
        !(token.expiresAt instanceof Date) ||
        token.expiresAt.getTime() <= Date.now() ||
        !Array.isArray(token.resources) ||
        token.resources.length !== 1 ||
        token.resources[0] !== resource ||
        !Array.isArray(token.scopes) ||
        !token.scopes.includes('mcp') ||
        token.confirmation ||
        typeof token.userId !== 'string' ||
        !uuid.test(token.userId)
      )
        return null;
      const user = await adapter.findOne<{ id: string; email: string; emailVerified: boolean }>({
        model: 'user',
        where: [{ field: 'id', value: token.userId }],
      });
      if (!user?.emailVerified || !allowed.has(user.email)) return null;
      const client = await adapter.findOne<{ disabled?: boolean }>({
        model: 'oauthClient',
        where: [{ field: 'clientId', value: String(token.clientId) }],
      });
      if (!client || client.disabled) return null;
      const consent = await adapter.findOne<{ scopes: string[] }>({
        model: 'oauthConsent',
        where: [
          { field: 'userId', value: user.id },
          { field: 'clientId', value: String(token.clientId) },
        ],
      });
      if (!consent?.scopes.includes('mcp')) return null;
      if (token.sessionId) {
        const session = await adapter.findOne<{ expiresAt: Date }>({
          model: 'session',
          where: [{ field: 'id', value: String(token.sessionId) }],
        });
        if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      }
      return { accountId: user.id, email: user.email };
    };
    const revoke = (userId: string, clientId: string) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent'])
          db.prepare(`DELETE FROM "${table}" WHERE "userId" = ? AND "clientId" = ?`).run(
            userId,
            clientId,
          );
        // A code approved before revocation must not restore a revoked authorization.
        db.prepare(
          `DELETE FROM verification WHERE json_valid(value) AND json_extract(value, '$.type') = 'authorization_code' AND json_extract(value, '$.userId') = ? AND json_extract(value, '$.query.client_id') = ?`,
        ).run(userId, clientId);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
    const route = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.origin !== origin) return fail(400);
      const p = url.pathname;
      if (url.search.length > 16384) return fail(414);
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' &&
        !['GET', 'HEAD'].includes(request.method)
      )
        return fail(403);
      const machine =
        [
          '/api/auth/oauth2/token',
          '/api/auth/oauth2/register',
          '/api/auth/oauth2/revoke',
          '/api/auth/oauth2/introspect',
        ].includes(p) &&
        !request.headers.has('cookie') &&
        !request.headers.has('origin') &&
        !request.headers.has('referer');
      if (!['GET', 'HEAD'].includes(request.method) && !machine && !sameOrigin(request, origin))
        return fail(403);
      if (
        request.method === 'GET' &&
        [
          '/.well-known/oauth-authorization-server',
          '/.well-known/oauth-authorization-server/api/auth',
          '/api/auth/.well-known/oauth-authorization-server',
        ].includes(p)
      )
        return Response.json(await auth.api.getOAuthServerConfig());
      if (
        request.method === 'GET' &&
        [
          '/.well-known/oauth-protected-resource',
          '/.well-known/oauth-protected-resource/mcp',
        ].includes(p)
      )
        return Response.json({
          resource,
          authorization_servers: [`${origin}/api/auth`],
          scopes_supported: ['mcp', 'offline_access'],
          bearer_methods_supported: ['header'],
        });
      if (p === '/oauth/app.css' && request.method === 'GET')
        return new Response(style, { headers: { 'content-type': 'text/css; charset=utf-8' } });
      if (p === '/oauth/app.js' && request.method === 'GET')
        return new Response(script, {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        });
      if (['/', '/oauth/login', '/oauth/consent'].includes(p) && request.method === 'GET') {
        const session = await sessionFor(request);
        const q = url.searchParams.get('oauth_query') ?? url.search.slice(1);
        if (p !== '/' && q && !(await verifyOAuthQueryParams(q, secret))) return fail(400);
        if (p === '/oauth/consent') {
          if (!session || !q) return fail(401);
          const params = new URLSearchParams(q);
          if (params.get('resource') !== resource || !scopesValid(params.get('scope')))
            return fail(400);
          return page(
            `<p>Signed in as ${escapeHtml(session.user.email)}</p><h2>Connect a client</h2><p>Allow client <strong>${escapeHtml(params.get('client_id') ?? '')}</strong> to read and write your memories${params.get('scope')?.includes('offline_access') ? ' and stay connected' : ''}?</p><button data-consent="yes">Allow access</button> <button data-consent="no">Deny</button>`,
          );
        }
        if (!session || p === '/oauth/login')
          return page(
            `<h2>Sign in</h2>${options.googleClientId ? '<button data-provider="google">Continue with Google</button>' : ''} ${options.githubClientId ? '<button data-provider="github">Continue with GitHub</button>' : ''}${url.searchParams.has('error') ? '<p>Sign-in failed. Use an approved, verified email address.</p>' : ''}`,
          );
        const consents = await adapter.findMany<{ id: string; clientId: string }>({
          model: 'oauthConsent',
          where: [{ field: 'userId', value: session.user.id }],
        });
        return page(
          `<p>${escapeHtml(session.user.email)}</p><p>Account <code>${escapeHtml(session.user.id)}</code></p><p>Connect your MCP client to <code>${escapeHtml(resource)}</code>.</p><h2>Connected clients</h2>${consents.length ? `<ul>${consents.map((c) => `<li>${escapeHtml(c.clientId)} <button data-revoke="${escapeHtml(c.id)}">Revoke access</button></li>`).join('')}</ul>` : '<p>No connected clients.</p>'}<button data-signout="yes">Sign out</button>`,
        );
      }
      if (p === '/oauth/revoke' && request.method === 'POST') {
        const s = await sessionFor(request);
        if (!s) return fail(401);
        const body = await readBody(request);
        if (typeof body.id !== 'string') return fail(400);
        const consent = await adapter.findOne<{ userId: string; clientId: string }>({
          model: 'oauthConsent',
          where: [{ field: 'id', value: body.id }],
        });
        if (!consent || consent.userId !== s.user.id) return fail(404);
        revoke(s.user.id, consent.clientId);
        return new Response(null, { status: 204 });
      }
      const publicPaths = [
        '/api/auth/sign-in/social',
        '/api/auth/sign-out',
        '/api/auth/get-session',
        '/api/auth/oauth2/authorize',
        '/api/auth/oauth2/consent',
        '/api/auth/oauth2/token',
        '/api/auth/oauth2/register',
        '/api/auth/oauth2/revoke',
        '/api/auth/oauth2/introspect',
        '/api/auth/oauth2/get-consents',
      ];
      if (!publicPaths.includes(p) && !/^\/api\/auth\/callback\/(google|github)$/.test(p))
        return fail(404);
      if (p.endsWith('/authorize')) {
        if (
          request.method !== 'GET' ||
          [...url.searchParams.keys()].some((k) => url.searchParams.getAll(k).length !== 1) ||
          url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('resource') !== resource ||
          !scopesValid(url.searchParams.get('scope')) ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')
        )
          return fail(400);
      }
      if (p.endsWith('/consent') || p.endsWith('/get-consents')) {
        if (!(await sessionFor(request))) return fail(401);
      }
      if (request.method === 'POST') {
        const body = await readBody(request);
        if (p.endsWith('/register')) {
          if (Date.now() - registrationWindow >= 60000) {
            registrationWindow = Date.now();
            registrations = 0;
          }
          if (++registrations > 20) return fail(429, 'registration_limit');
          const fields = [
            'client_name',
            'redirect_uris',
            'grant_types',
            'response_types',
            'token_endpoint_auth_method',
            'scope',
            'application_type',
            'resources',
          ];
          if (
            (body.grant_types !== undefined &&
              (!Array.isArray(body.grant_types) ||
                !body.grant_types.length ||
                !body.grant_types.every((g) =>
                  ['authorization_code', 'refresh_token'].includes(String(g)),
                ))) ||
            (body.token_endpoint_auth_method !== undefined &&
              !['none', 'client_secret_basic', 'client_secret_post'].includes(
                String(body.token_endpoint_auth_method),
              )) ||
            Object.keys(body).some((k) => !fields.includes(k)) ||
            !Array.isArray(body.redirect_uris) ||
            body.redirect_uris.length < 1 ||
            body.redirect_uris.length > 5 ||
            !body.redirect_uris.every(validRedirect) ||
            (body.client_name !== undefined &&
              (typeof body.client_name !== 'string' || body.client_name.length > 100)) ||
            (body.resources !== undefined &&
              (!Array.isArray(body.resources) ||
                body.resources.length !== 1 ||
                body.resources[0] !== resource))
          )
            return fail(400, 'invalid_client_metadata');
          // Anonymous registrations cannot reserve capacity permanently. Never evict consented clients.
          db.prepare(
            `DELETE FROM oauthClient WHERE clientId IN (
            SELECT c.clientId FROM oauthClient c WHERE c.createdAt < ?
            AND NOT EXISTS (SELECT 1 FROM oauthConsent g WHERE g.clientId = c.clientId)
          )`,
          ).run(Date.now() - 3600_000);
          const count = () =>
            Number((db.prepare('SELECT COUNT(*) AS n FROM oauthClient').get() as { n: number }).n);
          if (count() >= 1000) {
            db.exec(`DELETE FROM oauthClient WHERE clientId IN (
              SELECT c.clientId FROM oauthClient c
              WHERE NOT EXISTS (SELECT 1 FROM oauthConsent g WHERE g.clientId = c.clientId)
              ORDER BY c.createdAt ASC LIMIT 1
            )`);
          }
          if (count() >= 1000) return fail(429, 'registration_limit');
        }
        if (
          p.endsWith('/token') &&
          (!['authorization_code', 'refresh_token'].includes(String(body.grant_type)) ||
            body.resource !== resource)
        )
          return fail(400, 'invalid_target');
        if (p.endsWith('/token')) {
          const refresh = body.grant_type === 'refresh_token';
          const presented = refresh ? body.refresh_token : body.code;
          if (typeof presented !== 'string' || presented.length > 512)
            return fail(400, 'invalid_grant');
          const row = await adapter.findOne<Record<string, unknown>>({
            model: refresh ? 'oauthRefreshToken' : 'verification',
            where: [{ field: refresh ? 'token' : 'identifier', value: hash(presented) }],
          });
          // Missing/replayed codes must reach the provider's replay-family cleanup.
          if (row) {
            const grant = refresh
              ? row
              : (JSON.parse(String(row.value)) as Record<string, unknown>);
            if (typeof grant.userId !== 'string') return fail(400, 'invalid_grant');
            const user = await adapter.findOne<{ email: string; emailVerified: boolean }>({
              model: 'user',
              where: [{ field: 'id', value: grant.userId }],
            });
            if (!user?.emailVerified || !allowed.has(user.email) || !uuid.test(grant.userId))
              return fail(403, 'access_denied');
            const clientId = refresh
              ? grant.clientId
              : (grant.query as Record<string, unknown> | undefined)?.client_id;
            if (typeof clientId !== 'string') return fail(400, 'invalid_grant');
            const consent = await adapter.findOne<{ scopes: string[]; resources?: string[] }>({
              model: 'oauthConsent',
              where: [
                { field: 'userId', value: grant.userId },
                { field: 'clientId', value: clientId },
              ],
            });
            if (!consent?.scopes.includes('mcp') || !consent.resources?.includes(resource))
              return fail(400, 'invalid_grant');
          }
        }
        if (p.endsWith('/consent') || (p.endsWith('/social') && body.oauth_query)) {
          if (
            typeof body.oauth_query !== 'string' ||
            !(await verifyOAuthQueryParams(body.oauth_query, secret))
          )
            return fail(400);
          const params = new URLSearchParams(body.oauth_query);
          if (
            params.get('resource') !== resource ||
            !scopesValid(params.get('scope')) ||
            params.get('code_challenge_method') !== 'S256'
          )
            return fail(400);
          if (
            p.endsWith('/consent') &&
            Object.keys(body).some((k) => !['accept', 'oauth_query'].includes(k))
          )
            return fail(400);
        }
        request = withBody(request, body);
      }
      return auth.handler(request);
    };
    return {
      authenticate: (request) => exclusive(() => authenticate(request)),
      handle: async (request) => {
        let response: Response;
        try {
          // Uploads and provider callbacks must not hold the global grant-rotation queue.
          request = await bufferRequest(request, 16384);
          const path = new URL(request.url).pathname;
          const serialized =
            path === '/oauth/revoke' ||
            path === '/api/auth/sign-out' ||
            path.startsWith('/api/auth/oauth2/');
          if (closed) throw new Error('Auth service closed');
          response = serialized ? await exclusive(() => route(request)) : await route(request);
        } catch (error) {
          response =
            error instanceof BodyLimitError
              ? fail(error.status)
              : error instanceof InvalidRequest || error instanceof SyntaxError
                ? fail(400)
                : fail(503, 'temporarily_unavailable');
        }
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'no-referrer');
        headers.set(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
        return new Response(response.body, { status: response.status, headers });
      },
      close: async () => {
        await queue;
        if (!closed) {
          closed = true;
          db.close();
        }
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
