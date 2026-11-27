import { Hono } from 'hono';
import { BodyLimitError, bufferRequest } from './request-body.js';

import type { AccountStores } from './accounts.js';
import type { AuthIdentity, AuthService } from './auth/index.js';
import type { StoreContext } from './server.js';

export function createApplication({
  origin,
  auth,
  accounts,
}: {
  origin: string;
  auth: AuthService;
  accounts: AccountStores;
}) {
  return createHttpApplication({
    origin,
    auth,
    dispatch: async (accountId, request) => {
      const store = await accounts.get(accountId);
      return handleMcp(request, store, () => auth.authenticate(request), accountId);
    },
  });
}

export function createHttpApplication({
  origin,
  auth,
  ready,
  dispatch,
}: {
  origin: string;
  auth: Pick<AuthService, 'handle'> & {
    authenticate(request: Request): Promise<Pick<AuthIdentity, 'accountId'> | null>;
  };
  ready?: () => Promise<void>;
  dispatch(accountId: string, request: Request): Promise<Response>;
}) {
  const app = new Hono();
  let stopping = false;
  let active = 0;
  const byAccount = new Map<string, number>();
  const drained: (() => void)[] = [];
  app.onError((error) =>
    Response.json(
      { error: error instanceof BodyLimitError ? 'invalid_request' : 'temporarily_unavailable' },
      { status: error instanceof BodyLimitError ? error.status : 503 },
    ),
  );
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (stopping) return c.json({ error: 'shutting_down' }, 503);
    if (new URL(c.req.url).host !== new URL(origin).host)
      return c.json({ error: 'invalid_host' }, 400);
    const requestOrigin = c.req.header('origin');
    if (requestOrigin && requestOrigin !== origin) return c.json({ error: 'invalid_origin' }, 403);
    if (active >= 64) return c.json({ error: 'busy' }, 503, { 'Retry-After': '1' });
    active++;
    try {
      await next();
    } finally {
      active--;
      if (active === 0) for (const resolve of drained.splice(0)) resolve();
    }
  });
  app.get('/health', async (c) => {
    if (stopping) return c.json({ status: 'stopping' }, 503);
    await ready?.();
    return c.json({ status: 'ok' });
  });
  app.all('/mcp', async (c) => {
    const request = canonicalRequest(c.req.raw, origin);
    const identity = await auth.authenticate(request);
    if (!identity) return unauthorizedMcp(origin);
    // Stateless request/response MCP: no shared session ids, SSE streams or session authority.
    if (request.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
    if ((byAccount.get(identity.accountId) ?? 0) >= 16) {
      return c.json({ error: 'busy' }, 429, { 'Retry-After': '1' });
    }
    byAccount.set(identity.accountId, (byAccount.get(identity.accountId) ?? 0) + 1);
    try {
      return await dispatch(identity.accountId, await bufferRequest(request, 1024 * 1024));
    } finally {
      const remaining = (byAccount.get(identity.accountId) ?? 1) - 1;
      if (remaining) byAccount.set(identity.accountId, remaining);
      else byAccount.delete(identity.accountId);
    }
  });
  app.all('*', (c) => auth.handle(canonicalRequest(c.req.raw, origin)));
  return {
    async fetch(request: Request): Promise<Response> {
      const response = await app.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    async drain() {
      stopping = true;
      if (active) await new Promise<void>((resolve) => drained.push(resolve));
    },
  };
}

export function unauthorizedMcp(origin: string): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  );
}

export async function handleMcp(
  request: Request,
  store: StoreContext,
  authenticate: () => Promise<Pick<AuthIdentity, 'accountId'> | null>,
  accountId: string,
): Promise<Response> {
  // Keep the SDK's schema initialization out of the Worker bundle's startup path.
  const [{ createServer }, { WebStandardStreamableHTTPServerTransport }] = await Promise.all([
    import('./server.js'),
    import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
  ]);
  const server = await createServer(store, async () => {
    if ((await authenticate())?.accountId !== accountId)
      throw new Error('Authorization expired or revoked.');
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

// Render terminates TLS. Never derive authority from forwarded host/proto headers.
function canonicalRequest(request: Request, origin: string): Request {
  const url = new URL(request.url);
  const canonical = new Request(`${origin}${url.pathname}${url.search}`, request);
  canonical.headers.set('host', new URL(origin).host);
  for (const name of [...canonical.headers.keys()]) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) canonical.headers.delete(name);
  }
  return canonical;
}
