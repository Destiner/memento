// MCP server wiring for Memento. create_memory is live; the remaining tools
// are stubs until later tasks implement versioning, search, and answers.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type ResolvedConfig } from './config.js';
import { MementoError, toErrorShape } from './errors.js';
import { createMemory } from './store/create.js';
import { readMemory } from './store/read.js';
import {
  createMemoryInputShape,
  readMemoryInputShape,
  updateMemoryInputShape,
} from './store/schema.js';
import { updateMemory } from './store/update.js';

export const SERVER_NAME = 'memento';
export const SERVER_VERSION = '0.1.0';

const createMemoryOutputShape = {
  id: z.string(),
  path: z.string(),
  created: z.boolean(),
} as const;

const readMemoryOutputShape = {
  id: z.string(),
  metadata: z.object({
    title: z.string(),
    type: z.string(),
    scope: z.string(),
    status: z.string(),
  }),
  markdown: z.string(),
} as const;

const updateMemoryOutputShape = {
  id: z.string(),
  path: z.string(),
  updated: z.boolean(),
} as const;

const UNIMPLEMENTED_TOOLS: { name: string; description: string }[] = [
  {
    name: 'search_memory',
    description: 'Unified structured retrieval over stored memories.',
  },
  {
    name: 'answer_memory',
    description: 'Retrieval-and-synthesis convenience returning a source-backed answer.',
  },
];

export function createServer(resolved: ResolvedConfig = loadConfig()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    'create_memory',
    {
      description: 'Create a new canonical markdown memory.',
      inputSchema: createMemoryInputShape,
      outputSchema: createMemoryOutputShape,
    },
    async (args) => {
      try {
        const result = await createMemory(args, { memoriesDir: resolved.paths.memories });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(toErrorShape(error)) }],
        };
      }
    },
  );

  server.registerTool(
    'read_memory',
    {
      description: 'Read a single memory by stable ID.',
      inputSchema: readMemoryInputShape,
      outputSchema: readMemoryOutputShape,
    },
    async (args) => {
      try {
        const result = await readMemory(args, { memoriesDir: resolved.paths.memories });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(toErrorShape(error)) }],
        };
      }
    },
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Edit an existing memory in place (metadata changes and/or a body edit).',
      inputSchema: updateMemoryInputShape,
      outputSchema: updateMemoryOutputShape,
    },
    async (args) => {
      try {
        const result = await updateMemory(args, { memoriesDir: resolved.paths.memories });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(toErrorShape(error)) }],
        };
      }
    },
  );

  for (const { name, description } of UNIMPLEMENTED_TOOLS) {
    server.registerTool(name, { description }, () => {
      throw new MementoError('internal_error', `${name} is not implemented yet.`);
    });
  }

  return server;
}
