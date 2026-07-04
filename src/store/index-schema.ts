// SQLite schema for the derived search index (§6, §10).
//
// The index is non-authoritative: it is fully rebuildable from `memories/*.md`,
// so this DDL is disposable and may be dropped and recreated at any time. Bump
// INDEX_SCHEMA_VERSION whenever the table shape or tokenizer changes — startup
// detects the mismatch and rebuilds (see openIndex).
//
// Two tables share one database, joined by the string memory `id`:
//   - `memories`     — one row per memory, holding the structured/derived fields
//                      used for filtering (§9.3) and ranking (§10).
//   - `memories_fts` — an FTS5 virtual table over the lexical fields, providing
//                      BM25 relevance and match snippets.

export const INDEX_SCHEMA_VERSION = 1;

// Structured fields. `projects`/`entities`/`tags` are stored as JSON arrays and
// filtered with json_each so multi-valued matching stays in real SQL.
export const CREATE_MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS memories (
  rowid       INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  status      TEXT NOT NULL,
  importance  TEXT,
  confidence  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  projects    TEXT NOT NULL DEFAULT '[]',
  entities    TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]'
);
`;

// Lexical fields. `id` is carried UNINDEXED purely as the join key. The porter
// stemmer lets query terms match inflected forms (delivery/delayed).
export const CREATE_MEMORIES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  entities,
  tags,
  tokenize='porter unicode61'
);
`;

// Column index of `body` within memories_fts, used by snippet() for excerpts.
export const FTS_BODY_COLUMN = 2;
