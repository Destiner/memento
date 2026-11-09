import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { BodyLimitError, bufferRequest } from './request-body.js';

import type { AccountStores } from './accounts.js';
import type { AuthService } from './auth/index.js';
import { createServer } from './server.js';

export function createApplication({
  origin,
  auth,
  accounts,
}: {
  origin: string;
  auth: AuthService;
  accounts: AccountStores;
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
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
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
  app.get('/health', (c) => c.json({ status: stopping ? 'stopping' : 'ok' }, stopping ? 503 : 200));
  app.all('/mcp', async (c) => {
    let request = canonicalRequest(c.req.raw, origin);
    const identity = await auth.authenticate(request);
    if (!identity) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    // Stateless request/response MCP: no shared session ids, SSE streams or session authority.
    if (request.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
    if ((byAccount.get(identity.accountId) ?? 0) >= 16) {
      return c.json({ error: 'busy' }, 429, { 'Retry-After': '1' });
    }
    byAccount.set(identity.accountId, (byAccount.get(identity.accountId) ?? 0) + 1);
    try {
      request = await bufferRequest(request, 1024 * 1024);
      const store = await accounts.get(identity.accountId);
      const server = await createServer(store, async () => {
        const current = await auth.authenticate(request);
        if (current?.accountId !== identity.accountId)
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
    } finally {
      const remaining = (byAccount.get(identity.accountId) ?? 1) - 1;
      if (remaining) byAccount.set(identity.accountId, remaining);
      else byAccount.delete(identity.accountId);
    }
  });
  app.all('*', (c) => auth.handle(canonicalRequest(c.req.raw, origin)));
  return {
    fetch: app.fetch,
    async drain() {
      stopping = true;
      if (active) await new Promise<void>((resolve) => drained.push(resolve));
    },
  };
}

// Render terminates TLS. Use the configured origin, never forwarded host/proto headers.
function canonicalRequest(request: Request, origin: string): Request {
  const url = new URL(request.url);
  return new Request(`${origin}${url.pathname}${url.search}`, request);
}
