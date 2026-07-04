// The search_memory operation (§9.3): validate input, run the ranked index
// query, and shape each hit into a compact, agent-facing result with a
// relevance explanation. This is the retrieval tool agents reach for most.
//
// The operation owns two policies the raw index does not: clamping the caller's
// limit to the configured maximum (never return more than allowed), and building
// the `why_relevant` signals that let an agent decide whether to read the full
// memory without dumping bodies into context.

import { validate } from '../validation.js';
import { generateQueryId } from './id.js';
import { queryTerms, type MemoryIndex, type SearchHit } from './search-index.js';
import { searchMemoryInputSchema, type SearchMemoryInput } from './schema.js';

export interface SearchMemoryOptions {
  index: MemoryIndex;
  defaultLimit: number;
  maxLimit: number;
  // Injectable for deterministic tests; default to wall-clock / random id.
  now?: number;
  makeQueryId?: (now: number) => string;
}

export interface SearchResultItem {
  id: string;
  title: string;
  type: string;
  scope: string;
  score: number;
  why_relevant: string[];
  excerpt?: string;
  updated_at: string;
}

export interface SearchMemoryResult {
  query_id: string;
  results: SearchResultItem[];
  result_count: number;
}

export function searchMemory(rawInput: unknown, options: SearchMemoryOptions): SearchMemoryResult {
  const input = validate(searchMemoryInputSchema, rawInput);

  const limit = clampLimit(input.limit, options.defaultLimit, options.maxLimit);
  const hits = options.index.search(input.query, {
    limit,
    project: input.project,
    types: input.types,
    scopes: input.scopes,
    entities: input.entities,
    tags: input.tags,
    status: input.status,
  });

  const terms = new Set(queryTerms(input.query));
  const includeExcerpt = input.include_excerpt !== false;
  const results = hits.map((hit) => toResultItem(hit, input, terms, includeExcerpt));

  const queryId = (options.makeQueryId ?? generateQueryId)(options.now ?? Date.now());
  return { query_id: queryId, results, result_count: results.length };
}

// A caller may request fewer than the default, but never more than the maximum.
function clampLimit(requested: number | undefined, defaultLimit: number, maxLimit: number): number {
  return Math.min(requested ?? defaultLimit, maxLimit);
}

function toResultItem(
  hit: SearchHit,
  input: SearchMemoryInput,
  terms: Set<string>,
  includeExcerpt: boolean,
): SearchResultItem {
  const item: SearchResultItem = {
    id: hit.id,
    title: hit.title,
    type: hit.type,
    scope: hit.scope,
    score: round2(hit.score),
    why_relevant: whyRelevant(hit, input, terms),
    updated_at: hit.updated_at,
  };
  if (includeExcerpt && hit.excerpt) {
    item.excerpt = hit.excerpt;
  }
  return item;
}

// Compact, human-readable relevance signals (§9.3): which entities/projects the
// query hit, plus the overlapping terms. Always non-empty so the agent has a
// reason to weigh, falling back to a plain lexical note.
function whyRelevant(hit: SearchHit, input: SearchMemoryInput, terms: Set<string>): string[] {
  const why: string[] = [];

  const matchedEntities = hit.entities.filter((entity) => tokenMatch(entity, terms));
  if (matchedEntities.length) {
    why.push(`matched entity: ${matchedEntities.join(', ')}`);
  }

  const matchedProjects = hit.projects.filter(
    (project) => project === input.project || tokenMatch(project, terms),
  );
  if (matchedProjects.length) {
    why.push(`matched project: ${matchedProjects.join(', ')}`);
  }

  const matchedTerms = [...terms].filter((term) => tokenMatch(hit.title, new Set([term])));
  if (matchedTerms.length) {
    why.push(`matched title terms: ${matchedTerms.join(', ')}`);
  }

  if (why.length === 0) {
    why.push('lexical match in body');
  }
  return why;
}

// True when any of `terms` appears as a token within `value`.
function tokenMatch(value: string, terms: Set<string>): boolean {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= 2 && terms.has(token));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
