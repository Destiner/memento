// SQLite schema for the derived search index (v2.md §3, §5).
//
// The index is non-authoritative: it is fully rebuildable from `memories/*.md`,
// so this DDL is disposable and may be dropped and recreated at any time. Bump
// INDEX_SCHEMA_VERSION whenever the table shape or tokenizer changes — startup
// detects the mismatch and rebuilds (see openIndex).
//
// Two tables share one database, joined by the string memory `id`:
//   - `memories`     — one row per memory, holding the structured fields search
//                      filters on (scope, type, status) and ranks by.
//   - `memories_fts` — an FTS5 virtual table over the lexical fields, providing
//                      BM25 relevance.
//
// Version 2 is the V2 schema: `description` joins title and body as a lexical
// field, `projects`/`entities`/`tags` collapse to `project_ids` beside a
// `scope_kind`, and `importance`/`confidence` give way to provenance's `source`
// and `verification`. Dropping the `entities`/`tags` columns removes two ranking
// inputs; `description` matching and the `unverified` penalty replace them.

export const INDEX_SCHEMA_VERSION = 2;

// Structured fields. `project_ids` is a JSON array filtered with json_each, so
// multi-project matching (`any`/`all`) stays in real SQL.
export const CREATE_MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS memories (
  rowid        INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  type         TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,
  project_ids  TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL,
  source       TEXT NOT NULL,
  verification TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

// Lexical fields. `id` is carried UNINDEXED purely as the join key. The porter
// stemmer lets query terms match inflected forms (delivery/delayed).
export const CREATE_MEMORIES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  title,
  description,
  body,
  tokenize='porter unicode61'
);
`;
