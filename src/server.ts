// MCP server wiring for Memento. All five tool contracts (§9) are live: create,
// read, update, search, and the answer convenience layer.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type ResolvedConfig } from './config.js';
import { toErrorShape } from './errors.js';
import { answerMemory } from './store/answer.js';
import { createMemory } from './store/create.js';
import { openIndex } from './store/index-open.js';
import { readMemory } from './store/read.js';
import { searchMemory } from './store/search.js';
import {
  answerMemoryInputShape,
  createMemoryInputShape,
  readMemoryInputShape,
  searchMemoryInputShape,
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

const searchMemoryOutputShape = {
  query_id: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      scope: z.string(),
      score: z.number(),
      why_relevant: z.array(z.string()),
      excerpt: z.string().optional(),
      updated_at: z.string(),
    }),
  ),
  result_count: z.number(),
} as const;

const answerMemoryOutputShape = {
  answer: z.string(),
  sources: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      updated_at: z.string(),
    }),
  ),
  confidence: z.enum(['high', 'medium', 'low']),
  caveat: z.string(),
} as const;

export async function createServer(resolved: ResolvedConfig = loadConfig()): Promise<McpServer> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Open the derived index once at startup, rebuilding from markdown if it is
  // missing or its schema is out of date. Writes keep it in sync from here.
  const { index } = await openIndex({
    indexDir: resolved.paths.index,
    memoriesDir: resolved.paths.memories,
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
        const result = await createMemory(args, { memoriesDir: resolved.paths.memories, index });
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
        const result = await updateMemory(args, { memoriesDir: resolved.paths.memories, index });
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
    'search_memory',
    {
      description: 'Unified structured retrieval over stored memories.',
      inputSchema: searchMemoryInputShape,
      outputSchema: searchMemoryOutputShape,
    },
    (args) => {
      try {
        const result = searchMemory(args, {
          index,
          defaultLimit: resolved.config.default_result_limit,
          maxLimit: resolved.config.max_result_limit,
        });
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
    'answer_memory',
    {
      description: 'Retrieval-and-synthesis convenience returning a source-backed answer.',
      inputSchema: answerMemoryInputShape,
      outputSchema: answerMemoryOutputShape,
    },
    async (args) => {
      try {
        const result = await answerMemory(args, {
          index,
          memoriesDir: resolved.paths.memories,
          maxLimit: resolved.config.max_result_limit,
        });
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

  return server;
}
