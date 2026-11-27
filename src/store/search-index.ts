// The derived search index owns the FTS5 tables and the synchronous read/write
// paths against them. Callers hand it a validated record plus a body; it derives
// the lexical text and structured columns. The index is rebuildable from
// markdown, so failures are recoverable by rebuilding the derived index.
//
// It answers two questions, both of which need a cheap candidate pool over
// lexical similarity:
//
//   - `search`, for `search_memories`: rank a scope-filtered pool and return the
//     best hits.
//   - `candidates`, for `create_memory`'s dedupe gate: fetch the same-scope
//     neighbours of a draft so the operation can score them (similarity.ts) and
//     decide whether to gate the write.

import { CREATE_MEMORIES_FTS, CREATE_MEMORIES_TABLE, createSearchScratch } from './index-schema.js';
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
import {
  assertTermBudget,
  literalPattern,
  matchExpression,
  searchQuery,
  type QueryClause,
} from './search-query.js';
import { lexicalEvidence, type TermMatch } from './search-relevance.js';
import {
  openDurableSearchDatabase,
  openNodeSearchDatabase,
  type DurableSearchStorage,
  type SearchDatabase,
} from './search-sqlite.js';

// In-memory database sentinel, used by tests and ephemeral runs.
export const MEMORY_DB = ':memory:';

// Broad lexical retrieval precedes evidence-based acceptance. The requested
// limit is a ceiling, not a target to fill with weak matches.
const CANDIDATE_MULTIPLIER = 5;
const CANDIDATE_FLOOR = 30;

// How many neighbours the dedupe pool pulls before scoring. Generous relative to
// the handful the gate reports: bm25 orders the pool, but the similarity that
// decides the gate is computed in JS, so the pool has to be wide enough that a
// true duplicate cannot be ranked out of it by a lexically noisier neighbour.
const DEDUPE_POOL_SIZE = 25;

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

// `bm25` is raw lexical retrieval rank (more negative = better). `score` is
// bounded query evidence, not a probability or confidence calibrated across queries.
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
  body: string;
}

const SELECT_COLUMNS = `m.id, m.title, m.description, m.type, m.scope_kind, m.project_ids,
                m.status, m.source, m.verification, m.created_at, m.updated_at`;

export class MemoryIndex {
  private readonly db: SearchDatabase;

  constructor(location: string | DurableSearchStorage = MEMORY_DB) {
    this.db =
      typeof location === 'string'
        ? openNodeSearchDatabase(location)
        : openDurableSearchDatabase(location);
    this.db.transaction(() => {
      this.db.exec(CREATE_MEMORIES_TABLE);
      this.db.exec(CREATE_MEMORIES_FTS);
      for (const statement of createSearchScratch(this.db.scratchSchema)) this.db.exec(statement);
    });
  }

  static fromDurableStorage(storage: DurableSearchStorage): MemoryIndex {
    return new MemoryIndex(storage);
  }

  // Insert or replace a memory in both tables. Idempotent on `id`.
  upsert(record: MemoryRecord, body: string): void {
    this.db.transaction(() => {
      this.deleteById(record.id);
      this.insertRow(record, body);
    });
  }

  /** Retention reconciles interrupted state transitions against canonical files. */
  statusOf(id: string): MemoryStatus | undefined {
    const [row] = this.db.rows<{ status: MemoryStatus }>(
      'SELECT status FROM memories WHERE id = ?;',
      id,
    );
    return row?.status;
  }

  // Remove a memory from the index. Safe to call when absent.
  remove(id: string): void {
    this.db.transaction(() => this.deleteById(id));
  }

  // Drop all rows without touching the schema, so a rebuild can repopulate.
  clear(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM memories;');
      this.db.exec('DELETE FROM memories_fts;');
    });
  }

  count(): number {
    return this.countMatching();
  }

  private countMatching(filter?: SqlFilter): number {
    const where = filter ? ` WHERE ${filter.clauses.join(' AND ')}` : '';
    const [row] = this.db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memories m${where}`,
      ...(filter?.params ?? []),
    );
    return row!.n;
  }

  /** Broad FTS retrieval, followed by scope-local lexical evidence and abstention. */
  search(query: string, options: SearchOptions): SearchHit[] {
    const plan = searchQuery(query);
    if (!plan.terms.length) return [];
    // Validate actual SQLite expansion even when the requested scope is empty.
    const stems = this.queryStems(plan.terms);
    const filter = filters(options);
    const count = this.countMatching(filter);
    if (!count) return [];

    const clauses: QueryClause[] = plan.clauses.map((clause) => ({
      ...clause,
      terms: [...new Set(clause.terms.flatMap((term) => stems.get(term) ?? []))],
    }));
    const terms = [...new Set(clauses.flatMap((clause) => clause.terms))];
    if (!terms.length) return [];
    const matches = [
      ...this.db.rows<TermMatch>(
        `SELECT DISTINCT v.term, f.id, v.col AS column
         FROM ${this.db.scratchSchema}.search_vocab v
         JOIN memories_fts f ON f.rowid = v.doc
         JOIN memories m ON m.id = f.id
         WHERE v.term IN (${placeholders(terms.length)}) AND ${filter.clauses.join(' AND ')}`,
        ...terms,
        ...filter.params,
      ),
    ];
    const evidence = lexicalEvidence(clauses, matches, count);
    const pool = Math.max(options.limit * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR);
    const rows = this.searchPool(matchExpression(plan.terms), filter, pool, plan.clauses);
    const ranked: SearchHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const result = evidence(row);
      if (result.accepted) ranked.push({ ...toIndexed(row), bm25: row.bm25, score: result.score });
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.status === 'archived') - Number(b.status === 'archived') ||
        Number(a.verification === 'unverified') - Number(b.verification === 'unverified') ||
        a.bm25 - b.bm25 ||
        b.updated_at.localeCompare(a.updated_at) ||
        a.id.localeCompare(b.id),
    );
    return ranked.slice(0, options.limit);
  }

  private queryStems(terms: string[]): Map<string, string[]> {
    const schema = this.db.scratchSchema;
    return this.db.transaction(() => {
      this.db.exec(`DELETE FROM ${schema}.search_tokens`);
      // Bind only the term text to stay below workerd's 100-binding limit.
      const values = terms.map((_, i) => `(${i + 1}, ?)`).join(', ');
      this.db.exec(`INSERT INTO ${schema}.search_tokens (rowid, value) VALUES ${values}`, ...terms);
      const distinct = new Set<string>();
      const out = new Map<string, string[]>();
      for (const { term, doc } of this.db.rows<{ term: string; doc: number }>(
        `SELECT term, doc FROM ${schema}.search_stems`,
      )) {
        distinct.add(term);
        const key = terms[doc - 1]!;
        const values = out.get(key) ?? [];
        values.push(term);
        out.set(key, values);
      }
      assertTermBudget(distinct.size);
      this.db.exec(`DELETE FROM ${schema}.search_tokens`);
      return out;
    });
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
    return Array.from(rows, toIndexed);
  }

  close(): void {
    this.db.close();
  }

  private *searchPool(
    match: string,
    filter: SqlFilter,
    limit: number,
    clauses: QueryClause[],
  ): Iterable<MemoryRow> {
    const exact = clauses
      .filter((clause) => clause.literals.length)
      .map((clause) => ({ remaining: limit, patterns: clause.literals.map(literalPattern) }));
    if (!exact.length) {
      yield* this.selectPool(match, filter, limit, true);
      return;
    }

    // Each clause gets its own cap in the same BM25 order, even if prefix decoys
    // fill the broad pool. Walk one cursor instead of rescanning or using a UDF.
    let broad = limit;
    for (const row of this.selectPool(match, filter, undefined, true)) {
      let include = broad > 0;
      if (include) broad--;
      const text = `${row.title}\n${row.description}\n${row.body}`;
      for (const clause of exact) {
        if (clause.remaining > 0 && clause.patterns.every((pattern) => pattern.test(text))) {
          clause.remaining--;
          include = true;
        }
      }
      if (include) yield row;
      if (!broad && exact.every((clause) => !clause.remaining)) break;
    }
  }

  private selectPool(
    match: string,
    filter: SqlFilter,
    limit: number | undefined,
    weighted = false,
  ): Iterable<MemoryRow> {
    const where = ['memories_fts MATCH ?', ...filter.clauses].join(' AND ');
    const rank = weighted ? 'bm25(memories_fts, 0, 4, 2, 1)' : 'bm25(memories_fts)';
    return this.db.rows<MemoryRow>(
      `SELECT ${SELECT_COLUMNS}, ${weighted ? 'f.body' : "'' AS body"}, ${rank} AS bm25
       FROM memories_fts f
       JOIN memories m ON m.id = f.id
       WHERE ${where}
       ORDER BY bm25 ASC${weighted ? ', m.id ASC' : ''}${limit === undefined ? '' : ' LIMIT ?'};`,
      match,
      ...filter.params,
      ...(limit === undefined ? [] : [limit]),
    );
  }

  private deleteById(id: string): void {
    this.db.exec('DELETE FROM memories WHERE id = ?;', id);
    this.db.exec('DELETE FROM memories_fts WHERE id = ?;', id);
  }

  private insertRow(record: MemoryRecord, body: string): void {
    this.db.exec(
      `INSERT INTO memories
         (id, title, description, type, scope_kind, project_ids, status,
          source, verification, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
    this.db.exec(
      'INSERT INTO memories_fts (id, title, description, body) VALUES (?, ?, ?, ?);',
      record.id,
      record.title,
      record.description,
      body,
    );
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
