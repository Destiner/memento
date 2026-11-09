import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRemoteProjects, remoteConfiguration } from './remote.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('authenticated HTTP project lookup', () => {
  it.each([
    'http://localhost:3000/mcp',
    'https://user:pass@example.test/mcp',
    'https://example.test/mcp?token=x',
    'https://example.test/mcp#token',
    '',
  ])('rejects unsafe URL %s', (url) => {
    expect(() =>
      remoteConfiguration({ MEMENTO_URL: url, MEMENTO_ACCESS_TOKEN: 'fixture' }),
    ).toThrow(/MEMENTO_URL/);
  });

  it('requires a token from environment', () => {
    expect(() => remoteConfiguration({ MEMENTO_URL: 'https://example.test/mcp' })).toThrow(
      /MEMENTO_ACCESS_TOKEN/,
    );
  });

  it('uses SDK Streamable HTTP with bearer auth and validates tool results', async () => {
    vi.stubEnv('MEMENTO_URL', 'https://example.test/mcp');
    vi.stubEnv('MEMENTO_ACCESS_TOKEN', 'fixture-token');
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
        expect(init.redirect).toBe('error');
        const request = JSON.parse(String(init.body)) as { id?: number; method: string };
        requests.push(request.method);
        if (request.id === undefined) return new Response(null, { status: 202 });
        const result =
          request.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '0' },
              }
            : {
                content: [{ type: 'text', text: '{"outcome":"not_found"}' }],
                structuredContent: { outcome: 'not_found' },
              };
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      }),
    );
    const remote = await connectRemoteProjects();
    try {
      expect(await remote.lookup({ name_hint: 'fixture' })).toEqual({ outcome: 'not_found' });
      expect(requests).toContain('tools/call');
    } finally {
      await remote.close();
    }
  });

  it('does not expose SDK errors or fall back to local storage', async () => {
    vi.stubEnv('MEMENTO_URL', 'https://example.test/mcp');
    vi.stubEnv('MEMENTO_ACCESS_TOKEN', 'fixture-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Bearer fixture-token');
      }),
    );
    await expect(connectRemoteProjects()).rejects.toThrow(
      'Authenticated HTTP Memento connection failed',
    );
  });
});
