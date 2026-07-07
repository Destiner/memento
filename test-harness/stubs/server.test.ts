import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, test } from 'vitest';

import { getStubProfile } from './profiles.js';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

async function connect(profileId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', SERVER_PATH],
    env: { ...getDefaultEnvironment(), STUB_PROFILE: profileId },
  });
  const client = new Client({ name: 'harness-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('stub MCP server', () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  test('serves the profile name and its exact tool list over stdio', async () => {
    client = await connect('tracker');
    const profile = getStubProfile('tracker');

    expect(client.getServerVersion()?.name).toBe(profile.server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(profile.tools.map((t) => t.name).sort());
    for (const tool of tools) {
      expect(tool.description && tool.description.length).toBeTruthy();
    }
  }, 20_000);

  test('tools respond with a harmless no-op result', async () => {
    client = await connect('tracker');
    const result = (await client.callTool({ name: 'list_issues', arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    expect(result.content[0]?.text).toMatch(/stub/i);
  }, 20_000);
});
