// MCP server wiring for Memento. Tool handlers are stubs until later tasks
// implement the canonical store, search index, and answer interface.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_NAME = 'memento';
export const SERVER_VERSION = '0.1.0';

const TOOL_STUBS: { name: string; description: string }[] = [
  {
    name: 'create_memory',
    description: 'Create a new canonical markdown memory.',
  },
  {
    name: 'update_memory',
    description: 'Create a new version of an existing memory and update the canonical file.',
  },
  {
    name: 'search_memory',
    description: 'Unified structured retrieval over stored memories.',
  },
  {
    name: 'read_memory',
    description: 'Read a single memory by stable ID (current or historical).',
  },
  {
    name: 'answer_memory',
    description: 'Retrieval-and-synthesis convenience returning a source-backed answer.',
  },
];

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  for (const { name, description } of TOOL_STUBS) {
    server.registerTool(name, { description }, () => {
      throw new Error(`${name} is not implemented yet.`);
    });
  }

  return server;
}
