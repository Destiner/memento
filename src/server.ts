// MCP server wiring for Memento. All five tool contracts (§9) are live: create,
// read, update, search, and the answer convenience layer.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type ResolvedConfig } from './config.js';
import { toErrorShape } from './errors.js';
import { createLogger, type EventLogger } from './logging/logger.js';
import type { ToolEventFields } from './logging/events.js';
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

interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

// One choke point for every tool: run the operation, shape the MCP response, and
// emit an instrumentation event (§13). Success and error both log latency and
// outcome; `fields` contributes the per-tool, non-sensitive signals derived from
// the (already validated) result. Logging is fire-and-forget so it never adds
// disk latency to — or fails — the tool call.
async function runTool<T>(
  tool: string,
  logger: EventLogger,
  exec: () => T | Promise<T>,
  fields?: (result: T) => Partial<ToolEventFields>,
): Promise<ToolCallResult> {
  const start = performance.now();
  try {
    const result = await exec();
    const latency_ms = Math.round(performance.now() - start);
    void logger.log({ tool, outcome: 'success', latency_ms, ...fields?.(result) });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const latency_ms = Math.round(performance.now() - start);
    const shape = toErrorShape(error);
    void logger.log({ tool, outcome: 'error', latency_ms, error_code: shape.code });
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(shape) }],
    };
  }
}

// Names (never values) of the search filters the caller supplied, for §13's
// "filters_used". An empty array counts as absent.
function usedFilters(args: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const value = args[key];
    if (value === undefined) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });
}

const SEARCH_FILTER_KEYS = ['project', 'types', 'scopes', 'entities', 'tags', 'status'] as const;

export async function createServer(resolved: ResolvedConfig = loadConfig()): Promise<McpServer> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const logger = createLogger({
    logsDir: resolved.paths.logs,
    enabled: resolved.config.logging_enabled,
    serverVersion: SERVER_VERSION,
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
    (args) =>
      runTool(
        'create_memory',
        logger,
        () => createMemory(args, { memoriesDir: resolved.paths.memories, index }),
        () => ({ memory_type: args.type, memory_scope: args.scope }),
      ),
  );

  server.registerTool(
    'read_memory',
    {
      description: 'Read a single memory by stable ID.',
      inputSchema: readMemoryInputShape,
      outputSchema: readMemoryOutputShape,
    },
    (args) =>
      runTool('read_memory', logger, () =>
        readMemory(args, { memoriesDir: resolved.paths.memories }),
      ),
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Edit an existing memory in place (metadata changes and/or a body edit).',
      inputSchema: updateMemoryInputShape,
      outputSchema: updateMemoryOutputShape,
    },
    (args) =>
      runTool('update_memory', logger, () =>
        updateMemory(args, { memoriesDir: resolved.paths.memories, index }),
      ),
  );

  server.registerTool(
    'search_memory',
    {
      description: 'Unified structured retrieval over stored memories.',
      inputSchema: searchMemoryInputShape,
      outputSchema: searchMemoryOutputShape,
    },
    (args) =>
      runTool(
        'search_memory',
        logger,
        () =>
          searchMemory(args, {
            index,
            defaultLimit: resolved.config.default_result_limit,
            maxLimit: resolved.config.max_result_limit,
          }),
        (result) => ({
          result_count: result.result_count,
          query_id: result.query_id,
          query_length: args.query.length,
          filters_used: usedFilters(args as Record<string, unknown>, SEARCH_FILTER_KEYS),
        }),
      ),
  );

  server.registerTool(
    'answer_memory',
    {
      description: 'Retrieval-and-synthesis convenience returning a source-backed answer.',
      inputSchema: answerMemoryInputShape,
      outputSchema: answerMemoryOutputShape,
    },
    (args) =>
      runTool(
        'answer_memory',
        logger,
        () =>
          answerMemory(args, {
            index,
            memoriesDir: resolved.paths.memories,
            maxLimit: resolved.config.max_result_limit,
          }),
        (result) => ({
          source_count: result.sources.length,
          question_length: args.question.length,
          confidence: result.confidence,
        }),
      ),
  );

  return server;
}
