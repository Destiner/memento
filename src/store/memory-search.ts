// The search_memories operation (v2.md §5): validate input, run the ranked index
// query, and return lightweight summaries.
//
// The operation owns three policies the raw index does not:
//
//   - Project ids are existence-checked. A search scoped to an id no project
//     answers to is a mistake worth naming, not an empty result set that reads
//     like "nothing has been learned about this yet".
//   - The caller's limit is clamped to the configured maximum.
//   - Results are summaries only. No body, no provenance, no match excerpt — the
//     agent picks from title and description and calls `get_memory` for the rest,
//     which is what keeps a search cheap in context and makes the retrieval funnel
//     measurable.

import { validate } from '../validation.js';
import { generateQueryId } from './id.js';
import { searchMemoriesInputSchema, type SearchResultItem } from './memory-schema.js';
import { assertProjectsRegistered } from './project-registry.js';
import type { MemoryIndex, SearchHit } from './search-index.js';

export interface SearchMemoriesOptions {
  index: MemoryIndex;
  projectsDir: string;
  defaultLimit: number;
  maxLimit: number;
  // Injectable for deterministic tests; default to wall-clock / random id.
  now?: number;
  makeQueryId?: (now: number) => string;
}

export interface SearchMemoriesResult {
  query_id: string;
  results: SearchResultItem[];
  result_count: number;
}

export async function searchMemories(
  rawInput: unknown,
  options: SearchMemoriesOptions,
): Promise<SearchMemoriesResult> {
  const input = validate(searchMemoriesInputSchema, rawInput);

  if (input.scope.kind === 'projects') {
    await assertProjectsRegistered(options.projectsDir, input.scope.project_ids);
  }

  const hits = options.index.search(input.query, {
    scope: input.scope,
    types: input.types,
    status: input.status,
    limit: clampLimit(input.limit, options.defaultLimit, options.maxLimit),
  });

  const queryId = (options.makeQueryId ?? generateQueryId)(options.now ?? Date.now());
  return {
    query_id: queryId,
    results: hits.map(toResultItem),
    result_count: hits.length,
  };
}

// A caller may request fewer than the default, but never more than the maximum.
function clampLimit(requested: number | undefined, defaultLimit: number, maxLimit: number): number {
  return Math.min(requested ?? defaultLimit, maxLimit);
}

function toResultItem(hit: SearchHit): SearchResultItem {
  return {
    id: hit.id,
    title: hit.title,
    description: hit.description,
    scope: hit.scope,
    type: hit.type,
    status: hit.status,
    updated_at: hit.updated_at,
    score: Math.round(hit.score * 100) / 100,
  };
}
