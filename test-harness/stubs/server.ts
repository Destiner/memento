#!/usr/bin/env bun
// One stub MCP server for the crowded environment (harness-spec §7.3). Which
// persona it presents is chosen by the STUB_PROFILE env var (see `profiles.ts`);
// the runner launches one process per crowded profile, each under that profile's
// server name (`mcp.ts`). Every registered tool is a no-op: it exists only to
// crowd the agent's tool list and is never expected to be called during scoring.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getStubProfile } from './profiles.js';

const STUB_VERSION = '0.1.0';

async function main(): Promise<void> {
  const id = process.env.STUB_PROFILE;
  if (!id) throw new Error('STUB_PROFILE env var is required.');
  const profile = getStubProfile(id);

  const server = new McpServer({ name: profile.server, version: STUB_VERSION });
  for (const tool of profile.tools) {
    server.registerTool(tool.name, { description: tool.description }, () => ({
      content: [
        { type: 'text', text: `${profile.server}.${tool.name}: stub (test harness no-op).` },
      ],
    }));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
