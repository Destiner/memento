// The derived search index: a thin, synchronous wrapper over node:sqlite that
// owns the FTS5 tables and the read/write paths against them.
//
// This module is the only place that talks to SQLite. Callers hand it validated
// front matter plus a body; it derives the lexical text and structured columns.
// The index is rebuildable from markdown (§6), so any failure here is
// recoverable by dropping the database and re-running the rebuild routine.

import { DatabaseSync } from 'node:sqlite';

import { CREATE_MEMORIES_FTS, CREATE_MEMORIES_TABLE, FTS_BODY_COLUMN } from './index-schema.js';
import type {
  Confidence,
  Importance,
  MemoryMetadata,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from './schema.js';

// In-memory database sentinel, used by tests and ephemeral runs.
export const MEMORY_DB = ':memory:';

const EXCERPT_TOKENS = 18;

// Structured filters (§9.3). Within a category the values are OR-ed (match any);
// across categories they are AND-ed (all must hold). All are optional.
export interface SearchFilters {
  project?: string;
  types?: MemoryType[];
  scopes?: MemoryScope[];
  entities?: string[];
  tags?: string[];
  status?: MemoryStatus[];
}

export interface SearchOptions extends SearchFilters {
  limit: number;
}

// One ranked hit. `bm25` is the raw SQLite score (more negative = better);
// `score` is the normalized 0..1 relevance. Boosts/penalties refine `score` in
// a later task; here it reflects lexical relevance only.
export interface SearchHit {
  id: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  status: MemoryStatus;
  importance?: Importance;
  confidence?: Confidence;
  created_at: string;
  updated_at: string;
  projects: string[];
  entities: string[];
  tags: string[];
  bm25: number;
  score: number;
  excerpt: string;
}

interface MemoryRow {
  id: string;
  title: string;
  type: string;
  scope: string;
  status: string;
  importance: string | null;
  confidence: string | null;
  created_at: string;
  updated_at: string;
  projects: string;
  entities: string;
  tags: string;
  bm25: number;
  excerpt: string;
}

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
  upsert(metadata: MemoryMetadata, body: string): void {
    this.transaction(() => {
      this.deleteById(metadata.id);
      this.insertRow(metadata, body);
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

  // Lexical search over the FTS index, best match first. Returns [] for an
  // empty/termless query rather than erroring on an invalid MATCH expression.
  search(query: string, options: SearchOptions): SearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const filter = buildFilters(options);
    const where = ['memories_fts MATCH ?', ...filter.clauses].join(' AND ');

    const rows = this.db
      .prepare(
        `SELECT m.id, m.title, m.type, m.scope, m.status, m.importance, m.confidence,
                m.created_at, m.updated_at, m.projects, m.entities, m.tags,
                bm25(memories_fts) AS bm25,
                snippet(memories_fts, ${FTS_BODY_COLUMN}, '', '', '…', ${EXCERPT_TOKENS}) AS excerpt
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE ${where}
         ORDER BY bm25 ASC
         LIMIT ?;`,
      )
      .all(match, ...filter.params, options.limit) as unknown as MemoryRow[];

    return rows.map(toHit);
  }

  close(): void {
    this.db.close();
  }

  private deleteById(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?;').run(id);
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?;').run(id);
  }

  private insertRow(metadata: MemoryMetadata, body: string): void {
    const projects = metadata.projects ?? [];
    const entities = metadata.entities ?? [];
    const tags = metadata.tags ?? [];

    this.db
      .prepare(
        `INSERT INTO memories
           (id, title, type, scope, status, importance, confidence,
            created_at, updated_at, projects, entities, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        metadata.id,
        metadata.title,
        metadata.type,
        metadata.scope,
        metadata.status,
        metadata.importance ?? null,
        metadata.confidence ?? null,
        metadata.created_at,
        metadata.updated_at,
        JSON.stringify(projects),
        JSON.stringify(entities),
        JSON.stringify(tags),
      );

    this.db
      .prepare('INSERT INTO memories_fts (id, title, body, entities, tags) VALUES (?, ?, ?, ?, ?);')
      .run(metadata.id, metadata.title, body, entities.join(' '), tags.join(' '));
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

// Translate structured filters into parameterized SQL predicates. Scalar
// columns (type/scope/status) use IN; multi-valued JSON arrays (projects/
// entities/tags) use json_each so a memory matches if any of its values does.
function buildFilters(filters: SearchFilters): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.project) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(m.projects) WHERE value = ?)');
    params.push(filters.project);
  }
  addInClause(clauses, params, 'm.type', filters.types);
  addInClause(clauses, params, 'm.scope', filters.scopes);
  addInClause(clauses, params, 'm.status', filters.status);
  addJsonClause(clauses, params, 'm.entities', filters.entities);
  addJsonClause(clauses, params, 'm.tags', filters.tags);

  return { clauses, params };
}

function addInClause(
  clauses: string[],
  params: string[],
  column: string,
  values: string[] | undefined,
): void {
  if (!values?.length) return;
  clauses.push(`${column} IN (${placeholders(values.length)})`);
  params.push(...values);
}

function addJsonClause(
  clauses: string[],
  params: string[],
  column: string,
  values: string[] | undefined,
): void {
  if (!values?.length) return;
  clauses.push(
    `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value IN (${placeholders(values.length)}))`,
  );
  params.push(...values);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// Turn a natural-language query into a safe FTS5 MATCH expression: split into
// terms, drop single characters, quote each to neutralize FTS operators, and OR
// them so partial matches still surface (ranking sorts precise hits to the top).
export function toMatchQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(' OR ');
}

// Map bm25 (more negative is better) onto a monotonic 0..1 lexical relevance.
export function normalizeBm25(bm25: number): number {
  const relevance = Math.max(0, -bm25);
  return relevance / (relevance + 1);
}

function toHit(row: MemoryRow): SearchHit {
  return {
    id: row.id,
    title: row.title,
    type: row.type as MemoryType,
    scope: row.scope as MemoryScope,
    status: row.status as MemoryStatus,
    importance: (row.importance as Importance | null) ?? undefined,
    confidence: (row.confidence as Confidence | null) ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    projects: JSON.parse(row.projects) as string[],
    entities: JSON.parse(row.entities) as string[],
    tags: JSON.parse(row.tags) as string[],
    bm25: row.bm25,
    score: normalizeBm25(row.bm25),
    excerpt: row.excerpt.trim(),
  };
}
