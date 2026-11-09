import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { ProjectLookup } from './projects.js';

const project = z.object({ id: z.string().regex(/^prj_[a-zA-Z0-9_-]+$/) });
const resolution = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('exact_match'), matched_on: z.string(), project }),
  z.object({
    outcome: z.literal('candidates'),
    matched_on: z.string(),
    candidates: z.array(project),
  }),
]);

export function remoteConfiguration(env: NodeJS.ProcessEnv = process.env): {
  url: URL;
  token: string;
} {
  let url: URL;
  try {
    url = new URL(env.MEMENTO_URL ?? '');
  } catch {
    throw new Error('MEMENTO_URL must be an HTTPS MCP endpoint.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MEMENTO_URL must use HTTPS without credentials, query, or fragment.');
  }
  const token = env.MEMENTO_ACCESS_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new Error('MEMENTO_ACCESS_TOKEN must contain an access token supplied via environment.');
  }
  return { url, token };
}

export async function connectRemoteProjects(): Promise<{
  lookup: ProjectLookup;
  close(): Promise<void>;
}> {
  const { url, token } = remoteConfiguration();
  const client = new Client({ name: 'memento-retrospective', version: '1.4.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  try {
    await client.connect(transport);
  } catch {
    await client.close().catch(() => undefined);
    throw new Error(
      'Authenticated HTTP Memento connection failed; check endpoint and environment credentials.',
    );
  }
  return {
    async lookup(input) {
      try {
        const result = await client.callTool({ name: 'resolve_project', arguments: input });
        if (result.isError) throw new Error('Tool failed');
        const content = z.array(z.object({ type: z.string(), text: z.string().optional() }));
        const value =
          result.structuredContent ??
          JSON.parse(
            content
              .parse(result.content)
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('\n'),
          );
        return resolution.parse(value);
      } catch {
        // SDK errors can contain headers or server-provided text. Do not persist them.
        throw new Error(
          'Remote project resolution failed; no local registry fallback is permitted.',
        );
      }
    },
    close: () => client.close(),
  };
}
