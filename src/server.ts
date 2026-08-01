// MCP server wiring for Memento. All eight V2 tool contracts are live (v2.md §4):
// three project tools and five memory tools.
//
// Every tool goes through `runTool`, which is the one place that shapes an MCP
// response and emits an instrumentation event. Two conventions matter here:
//
//   - A soft outcome is a success. `resolve_project` finding nothing, and either
//     create returning duplicate candidates, are ordinary results with an
//     `outcome` field — not `isError`. An error response teaches an agent the tool
//     is broken; these are answers, and each one names the agent's next move.
//   - The operations own their contracts. This layer validates nothing itself: the
//     input shapes come from the schema modules, so the tool surface and a direct
//     call cannot disagree.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadConfig, type ResolvedConfig } from './config.js';
import { toErrorShape } from './errors.js';
import { createLogger, type EventLogger } from './logging/logger.js';
import type { ToolEventFields } from './logging/events.js';
import { POLICY_VERSION } from './policy/index.js';
import { generateSessionId } from './store/id.js';
import { archiveMemory } from './store/memory-archive.js';
import { createMemory } from './store/memory-create.js';
import { getMemory } from './store/memory-get.js';
import {
  archiveMemoryInputShape,
  createMemoryInputShape,
  getMemoryInputShape,
  searchMemoriesInputShape,
  updateMemoryInputShape,
} from './store/memory-schema.js';
import { searchMemories } from './store/memory-search.js';
import { updateMemory } from './store/memory-update.js';
import { openIndex } from './store/index-open.js';
import { createProject } from './store/project-create.js';
import { resolveProject } from './store/project-resolve.js';
import {
  createProjectInputShape,
  resolveProjectInputShape,
  updateProjectInputShape,
} from './store/project-schema.js';
import { updateProject } from './store/project-update.js';
import {
  archiveMemoryOutputShape,
  createMemoryOutputShape,
  createProjectOutputShape,
  getMemoryOutputShape,
  resolveProjectOutputShape,
  searchMemoriesOutputShape,
  updateMemoryOutputShape,
  updateProjectOutputShape,
} from './tool-outputs.js';
import { resolveVariant } from './variants/index.js';

export const SERVER_NAME = 'memento';
// Kept in step with package.json by a test: the harness pools runs by the package
// version while the event log records this one, so a drift between them silently
// mixes pre- and post-change reps in one comparison.
export const SERVER_VERSION = '0.3.1';

interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

// One choke point for every tool: run the operation, shape the MCP response, and
// emit an instrumentation event. Success and error both log latency and outcome;
// `fields` contributes the per-tool, non-sensitive signals derived from the
// (already validated) result. `nudge` optionally returns advisory text appended as
// an extra content block on success (variant knob) — the structured payload is
// never altered. Logging is fire-and-forget so it never adds disk latency to — or
// fails — the tool call.
async function runTool<T>(
  tool: string,
  logger: EventLogger,
  exec: () => T | Promise<T>,
  fields?: (result: T) => Partial<ToolEventFields>,
  nudge?: (result: T) => string | undefined,
): Promise<ToolCallResult> {
  const start = performance.now();
  try {
    const result = await exec();
    const latency_ms = Math.round(performance.now() - start);
    void logger.log({ tool, outcome: 'success', latency_ms, ...fields?.(result) });
    const content: ToolCallResult['content'] = [{ type: 'text', text: JSON.stringify(result) }];
    const note = nudge?.(result);
    if (note) content.push({ type: 'text', text: note });
    return {
      content,
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

// Names (never values) of the search filters the caller supplied. An empty array
// counts as absent.
function usedFilters(args: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const value = args[key];
    if (value === undefined) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });
}

const SEARCH_FILTER_KEYS = ['types', 'status', 'limit'] as const;

// A memory scope, as the event log records it: the kind, how many projects, and
// their opaque ids. The ids are what make per-project activation answerable —
// they carry no name, path, or remote, and only resolve against the local
// registry the log sits beside.
function scopeFields(scope: { kind: string; project_ids?: readonly string[] }): {
  scope_kind: string;
  project_count: number;
  project_ids?: string[];
} {
  const ids = scope.project_ids;
  return {
    scope_kind: scope.kind,
    project_count: ids?.length ?? 0,
    ...(ids?.length ? { project_ids: [...ids] } : {}),
  };
}

export async function createServer(resolved: ResolvedConfig = loadConfig()): Promise<McpServer> {
  const variant = resolveVariant(resolved.variant);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    variant.instructions ? { instructions: variant.instructions } : undefined,
  );

  const logger = createLogger({
    logsDir: resolved.paths.logs,
    enabled: resolved.config.logging_enabled,
    serverVersion: SERVER_VERSION,
    policyVersion: POLICY_VERSION,
    variant: variant.name,
    sessionId: generateSessionId(),
    // Resolved per call: the client names itself during the initialize handshake,
    // which has not happened yet at this point in startup.
    client: () => server.server.getClientVersion(),
  });

  // Open the derived index once at startup, rebuilding from markdown if it is
  // missing or its schema is out of date. Writes keep it in sync from here.
  const { index } = await openIndex({
    indexDir: resolved.paths.index,
    memoriesDir: resolved.paths.memories,
  });

  const memoriesDir = resolved.paths.memories;
  const projectsDir = resolved.paths.projects;

  server.registerTool(
    'resolve_project',
    {
      description: variant.descriptions.resolve_project,
      inputSchema: resolveProjectInputShape,
      outputSchema: resolveProjectOutputShape,
    },
    (args) =>
      runTool(
        'resolve_project',
        logger,
        () => resolveProject(args, { projectsDir }),
        (result) => ({
          result_outcome: result.outcome,
          matched_on: result.outcome === 'not_found' ? undefined : result.matched_on,
          project_ids: result.outcome === 'exact_match' ? [result.project.id] : undefined,
          candidate_count: result.outcome === 'candidates' ? result.candidates.length : undefined,
          candidate_ids:
            result.outcome === 'candidates' ? result.candidates.map((c) => c.id) : undefined,
          suggestion_count:
            result.outcome === 'exact_match' ? result.suggestions.length : undefined,
        }),
      ),
  );

  server.registerTool(
    'create_project',
    {
      description: variant.descriptions.create_project,
      inputSchema: createProjectInputShape,
      outputSchema: createProjectOutputShape,
    },
    (args) =>
      runTool(
        'create_project',
        logger,
        async () => {
          const result = await createProject(args, { projectsDir });
          return result.outcome === 'created'
            ? { outcome: result.outcome, id: result.id, path: result.path, project: result.record }
            : result;
        },
        (result) => ({
          result_outcome: result.outcome,
          project_ids: 'id' in result ? [result.id] : undefined,
          candidate_count: 'candidates' in result ? result.candidates.length : undefined,
          candidate_ids: 'candidates' in result ? result.candidates.map((c) => c.id) : undefined,
          forced: args.force_create === true ? true : undefined,
        }),
      ),
  );

  server.registerTool(
    'update_project',
    {
      description: variant.descriptions.update_project,
      inputSchema: updateProjectInputShape,
      outputSchema: updateProjectOutputShape,
    },
    (args) =>
      runTool(
        'update_project',
        logger,
        async () => {
          const result = await updateProject(args, { projectsDir });
          return {
            id: result.id,
            path: result.path,
            updated: result.updated,
            project: result.record,
          };
        },
        (result) => ({ project_ids: [result.id] }),
      ),
  );

  server.registerTool(
    'search_memories',
    {
      description: variant.descriptions.search_memories,
      inputSchema: searchMemoriesInputShape,
      outputSchema: searchMemoriesOutputShape,
    },
    (args) =>
      runTool(
        'search_memories',
        logger,
        () =>
          searchMemories(args, {
            index,
            projectsDir,
            defaultLimit: resolved.config.default_result_limit,
            maxLimit: resolved.config.max_result_limit,
          }),
        (result) => ({
          result_count: result.result_count,
          result_ids: result.results.map((r) => r.id),
          query_id: result.query_id,
          query_length: args.query.length,
          filters_used: usedFilters(args as Record<string, unknown>, SEARCH_FILTER_KEYS),
          match_mode: args.scope.kind === 'projects' ? args.scope.match : undefined,
          ...scopeFields(args.scope),
        }),
        (result) => (result.result_count === 0 ? variant.nudges.emptySearch : undefined),
      ),
  );

  server.registerTool(
    'get_memory',
    {
      description: variant.descriptions.get_memory,
      inputSchema: getMemoryInputShape,
      outputSchema: getMemoryOutputShape,
    },
    (args) =>
      runTool(
        'get_memory',
        logger,
        () => getMemory(args, { memoriesDir, projectsDir }),
        (result) => ({
          memory_id: result.id,
          memory_type: result.type,
          ...scopeFields(result.scope),
        }),
      ),
  );

  server.registerTool(
    'create_memory',
    {
      description: variant.descriptions.create_memory,
      inputSchema: createMemoryInputShape,
      outputSchema: createMemoryOutputShape,
    },
    (args) =>
      runTool(
        'create_memory',
        logger,
        () => createMemory(args, { memoriesDir, projectsDir, index }),
        (result) => ({
          result_outcome: result.outcome,
          memory_id: 'id' in result ? result.id : undefined,
          memory_type: args.type,
          verification: args.provenance.verification,
          ...scopeFields(args.scope),
          candidate_count: 'candidates' in result ? result.candidates.length : undefined,
          candidate_ids: 'candidates' in result ? result.candidates.map((c) => c.id) : undefined,
          dropped_evidence_count:
            'dropped_evidence' in result ? result.dropped_evidence.length : undefined,
          forced: args.force_create === true ? true : undefined,
        }),
        (result) => (result.outcome === 'created' ? variant.nudges.createSuccess : undefined),
      ),
  );

  server.registerTool(
    'update_memory',
    {
      description: variant.descriptions.update_memory,
      inputSchema: updateMemoryInputShape,
      outputSchema: updateMemoryOutputShape,
    },
    (args) =>
      runTool(
        'update_memory',
        logger,
        () => updateMemory(args, { memoriesDir, projectsDir, index }),
        (result) => ({
          memory_id: result.id,
          memory_type: result.memory.type,
          ...scopeFields(result.memory.scope),
          mark_verified: args.mark_verified === true ? true : undefined,
          dropped_evidence_count: result.dropped_evidence.length,
        }),
      ),
  );

  server.registerTool(
    'archive_memory',
    {
      description: variant.descriptions.archive_memory,
      inputSchema: archiveMemoryInputShape,
      outputSchema: archiveMemoryOutputShape,
    },
    (args) =>
      runTool(
        'archive_memory',
        logger,
        () => archiveMemory(args, { memoriesDir, index }),
        (result) => ({
          memory_id: result.id,
          memory_type: result.memory.type,
          ...scopeFields(result.memory.scope),
        }),
      ),
  );

  return server;
}
