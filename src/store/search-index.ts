// The derived search index: a thin, synchronous wrapper over node:sqlite that
// owns the FTS5 tables and the read/write paths against them.
//
// This module is the only place that talks to SQLite. Callers hand it a validated
// record plus a body; it derives the lexical text and structured columns. The
// index is rebuildable from markdown, so any failure here is recoverable by
// dropping the database and re-running the rebuild routine.
//
// It answers two questions, both of which need a cheap candidate pool over
// lexical similarity:
//
//   - `search`, for `search_memories`: rank a scope-filtered pool and return the
//     best hits.
//   - `candidates`, for `create_memory`'s dedupe gate: fetch the same-scope
//     neighbours of a draft so the operation can score them (similarity.ts) and
//     decide whether to gate the write.

import { DatabaseSync } from 'node:sqlite';

import { CREATE_MEMORIES_FTS, CREATE_MEMORIES_TABLE } from './index-schema.js';
import {
  memoryProjectIds,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type ProjectMatchMode,
  type ProvenanceSource,
  type SearchScope,
  type VerificationLevel,
} from './memory-schema.js';

// In-memory database sentinel, used by tests and ephemeral runs.
export const MEMORY_DB = ':memory:';

// Re-rank a candidate pool this many times the requested limit, so a strong
// metadata boost can lift a lexically-weaker memory into the top results.
const CANDIDATE_MULTIPLIER = 5;
const CANDIDATE_FLOOR = 30;

// How many neighbours the dedupe pool pulls before scoring. Generous relative to
// the handful the gate reports: bm25 orders the pool, but the similarity that
// decides the gate is computed in JS, so the pool has to be wide enough that a
// true duplicate cannot be ranked out of it by a lexically noisier neighbour.
const DEDUPE_POOL_SIZE = 25;

// Additive metadata adjustments applied on top of the 0..1 lexical score. Boosts
// are modest so lexical relevance dominates; the archived penalty is large enough
// to keep a retired memory below its replacement whenever both are requested.
const RANK = {
  titleMatch: 0.12,
  descriptionMatch: 0.1,
  active: 0.05,
  archived: -0.4,
  // Asserted-but-unchecked knowledge ranks below knowledge that was observed,
  // confirmed, or sourced (§9).
  unverified: -0.08,
} as const;

/**
 * A scope to filter by. `SearchScope` (which carries `match`) and a memory's own
 * `MemoryScope` (which does not) are both accepted: the dedupe pool needs the
 * neighbours of a draft memory, which is an `any` match over its project ids.
 */
export type ScopeFilter = SearchScope | MemoryScope;

export interface SearchOptions {
  scope: ScopeFilter;
  types?: MemoryType[];
  status?: MemoryStatus[];
  limit: number;
}

export interface DedupeOptions {
  title: string;
  description: string;
  scope: ScopeFilter;
  limit?: number;
}

/** One indexed memory, as the index can reconstruct it (no body, no evidence). */
export interface IndexedMemory {
  id: string;
  title: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  status: MemoryStatus;
  source: ProvenanceSource;
  verification: VerificationLevel;
  created_at: string;
  updated_at: string;
}

// One ranked hit. `bm25` is the raw SQLite score (more negative = better);
// `score` is the adjusted 0..1 relevance.
export interface SearchHit extends IndexedMemory {
  bm25: number;
  score: number;
}

interface MemoryRow {
  id: string;
  title: string;
  description: string;
  type: string;
  scope_kind: string;
  project_ids: string;
  status: string;
  source: string;
  verification: string;
  created_at: string;
  updated_at: string;
  bm25: number;
}

const SELECT_COLUMNS = `m.id, m.title, m.description, m.type, m.scope_kind, m.project_ids,
                m.status, m.source, m.verification, m.created_at, m.updated_at,
                bm25(memories_fts) AS bm25`;

export class MemoryIndex {
  private readonly db: DatabaseSync;

  constructor(location: string = MEMORY_DB) {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(CREATE_MEMORIES_TABLE);
    this.db.exec(CREATE_MEMORIES_FTS);
  }

  // Insert or replace a memory in both tables. Idempotent on `id`.
  upsert(record: MemoryRecord, body: string): void {
    this.transaction(() => {
      this.deleteById(record.id);
      this.insertRow(record, body);
    });
  }

  // Remove a memory from the index. Safe to call when absent.
  remove(id: string): void {
    this.transaction(() => this.deleteById(id));
  }

  // Drop all rows without touching the schema, so a rebuild can repopulate.
  clear(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM memories;');
      this.db.exec('DELETE FROM memories_fts;');
    });
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories;').get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /**
   * Ranked search: pull a lexical candidate pool from FTS, apply the metadata
   * boosts and penalties, then return the top `limit` best-scoring hits.
   *
   * Returns [] for an empty or termless query rather than erroring on MATCH.
   */
  search(query: string, options: SearchOptions): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    const pool = Math.max(options.limit * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR);
    const rows = this.selectPool(orQuery(terms), filters(options), pool);

    const termSet = new Set(terms);
    const ranked = rows.map((row) => {
      const hit = toHit(row);
      const rank = rankScore(hit, termSet);
      hit.score = clamp01(rank);
      return { hit, rank };
    });

    // Sort by adjusted rank; break ties by recency (ISO timestamps sort lexically).
    ranked.sort((a, b) => b.rank - a.rank || b.hit.updated_at.localeCompare(a.hit.updated_at));
    return ranked.slice(0, options.limit).map((entry) => entry.hit);
  }

  /**
   * Same-scope neighbours of a draft memory, for the dedupe gate.
   *
   * Unranked and unfiltered by status: the caller scores them itself, and an
   * archived near-duplicate is worth showing — restoring it is better than
   * writing its replacement alongside it.
   */
  candidates(options: DedupeOptions): IndexedMemory[] {
    const terms = queryTerms(`${options.title} ${options.description}`);
    if (terms.length === 0) return [];

    const rows = this.selectPool(
      orQuery(terms),
      filters({ scope: options.scope }),
      options.limit ?? DEDUPE_POOL_SIZE,
    );
    return rows.map(toIndexed);
  }

  close(): void {
    this.db.close();
  }

  private selectPool(match: string, filter: SqlFilter, limit: number): MemoryRow[] {
    const where = ['memories_fts MATCH ?', ...filter.clauses].join(' AND ');
    return this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE ${where}
         ORDER BY bm25 ASC
         LIMIT ?;`,
      )
      .all(match, ...filter.params, limit) as unknown as MemoryRow[];
  }

  private deleteById(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?;').run(id);
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?;').run(id);
  }

  private insertRow(record: MemoryRecord, body: string): void {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, title, description, type, scope_kind, project_ids, status,
            source, verification, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        record.id,
        record.title,
        record.description,
        record.type,
        record.scope.kind,
        JSON.stringify(memoryProjectIds(record)),
        record.status,
        record.provenance.source,
        record.provenance.verification,
        record.created_at,
        record.updated_at,
      );

    this.db
      .prepare('INSERT INTO memories_fts (id, title, description, body) VALUES (?, ?, ?, ?);')
      .run(record.id, record.title, record.description, body);
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN;');
    try {
      fn();
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }
}

interface SqlFilter {
  clauses: string[];
  params: (string | number)[];
}

/**
 * Translate the scope and the optional type/status filters into parameterized
 * SQL predicates.
 *
 * Scope is always present and never widens: a `projects` search cannot return a
 * `global` memory, and a `global` search cannot return a project-scoped one
 * (memory-schema.ts, `searchScopeSchema`).
 */
function filters(options: { scope: ScopeFilter; types?: MemoryType[]; status?: MemoryStatus[] }) {
  const filter: SqlFilter = { clauses: [], params: [] };
  addScope(filter, options.scope);
  addInClause(filter, 'm.type', options.types);
  addInClause(filter, 'm.status', options.status);
  return filter;
}

function addScope(filter: SqlFilter, scope: ScopeFilter): void {
  if (scope.kind === 'global') {
    filter.clauses.push("m.scope_kind = 'global'");
    return;
  }

  filter.clauses.push("m.scope_kind = 'projects'");
  const ids = scope.project_ids;
  const list = placeholders(ids.length);

  if (matchMode(scope) === 'all') {
    // Every supplied id must appear on the memory. Counting distinct matches
    // against the supplied count is what makes this a superset test rather than
    // an intersection one.
    filter.clauses.push(
      `(SELECT COUNT(DISTINCT value) FROM json_each(m.project_ids) WHERE value IN (${list})) = ?`,
    );
    filter.params.push(...ids, ids.length);
    return;
  }

  filter.clauses.push(`EXISTS (SELECT 1 FROM json_each(m.project_ids) WHERE value IN (${list}))`);
  filter.params.push(...ids);
}

// A `MemoryScope` carries no match mode; the neighbours of a draft memory are an
// `any` match over its ids.
function matchMode(scope: Extract<ScopeFilter, { kind: 'projects' }>): ProjectMatchMode {
  return 'match' in scope ? scope.match : 'any';
}

function addInClause(filter: SqlFilter, column: string, values: string[] | undefined): void {
  if (!values?.length) return;
  filter.clauses.push(`${column} IN (${placeholders(values.length)})`);
  filter.params.push(...values);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// Tokenize a query into lowercase terms, dropping single characters and
// punctuation. Shared by the MATCH builder and the metadata boost checks.
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2);
}

// Quote each term to neutralize FTS operators and OR them so partial matches
// still surface (ranking sorts precise hits to the top).
function orQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term}"`).join(' OR ');
}

// Turn a natural-language query into a safe FTS5 MATCH expression, or null when
// nothing in it is usable.
export function toMatchQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return orQuery(terms);
}

/**
 * Adjust the lexical score with metadata boosts and penalties.
 *
 * Title and description matches are rewarded because both are short, curated
 * fields — a term hit there says more than the same hit buried in a body. Status
 * and verification move a memory relative to its peers rather than filtering it.
 */
function rankScore(hit: SearchHit, terms: Set<string>): number {
  let score = hit.score;

  if (matchesTerms([hit.title], terms)) score += RANK.titleMatch;
  if (matchesTerms([hit.description], terms)) score += RANK.descriptionMatch;

  if (hit.status === 'active') score += RANK.active;
  else if (hit.status === 'archived') score += RANK.archived;

  if (hit.verification === 'unverified') score += RANK.unverified;

  return score;
}

// True when any query term appears as a token within one of the values (so
// "billing" matches a title containing "billing-service").
function matchesTerms(values: string[], terms: Set<string>): boolean {
  return values.some((value) =>
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((token) => token.length >= 2 && terms.has(token)),
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Map bm25 (more negative is better) onto a monotonic 0..1 lexical relevance.
export function normalizeBm25(bm25: number): number {
  const relevance = Math.max(0, -bm25);
  return relevance / (relevance + 1);
}

function toIndexed(row: MemoryRow): IndexedMemory {
  const projectIds = JSON.parse(row.project_ids) as string[];
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    type: row.type as MemoryType,
    scope:
      row.scope_kind === 'global'
        ? { kind: 'global' }
        : { kind: 'projects', project_ids: projectIds },
    status: row.status as MemoryStatus,
    source: row.source as ProvenanceSource,
    verification: row.verification as VerificationLevel,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toHit(row: MemoryRow): SearchHit {
  return { ...toIndexed(row), bm25: row.bm25, score: normalizeBm25(row.bm25) };
}
