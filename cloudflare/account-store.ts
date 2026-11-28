import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { withAccountEventLog } from '../src/logging/logger.js';
import { StoreContext } from '../src/store/context.js';
import { INDEX_SCHEMA_VERSION } from '../src/store/index-schema.js';
import { withSerializedMemoryStore } from '../src/store/memory-mutation-lock.js';
import { rebuildIndexUnlocked } from '../src/store/rebuild.js';
import { MemoryIndex } from '../src/store/search-index.js';

export type AccountDocument = { path: string; contents: string };

const MAX_DOCUMENTS = 1_024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_ACCOUNT_BYTES = 8 * 1024 * 1024;

export const ACCOUNT_DOCUMENT_LIMITS = Object.freeze({
  maxDocuments: MAX_DOCUMENTS,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxAccountBytes: MAX_ACCOUNT_BYTES,
});

const MAX_LOG_EVENTS = 256;
const MAX_EVENTS_PER_REQUEST = 32;
const MAX_EVENT_BYTES = 8 * 1024;
const BATCH_SIZE = 40; // Stay under SQLite's 100-bound-parameter limit.
const DOCUMENT_DIRS = ['memories', 'projects'] as const;
const SCRATCH_FILENAME_PREFIX = '.memento-document-';

type Documents = Map<string, string>;
type EventLine = { filename: string; line: string };
type AccountState = {
  initialized: number;
  clean_index_version: number | null;
  scratch_id: string | null;
};

function ensureTables(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS account_documents (
      path TEXT PRIMARY KEY NOT NULL,
      contents TEXT NOT NULL,
      size INTEGER GENERATED ALWAYS AS (length(CAST(contents AS BLOB))) STORED
        CHECK (size <= ${MAX_DOCUMENT_BYTES})
    );
    CREATE TABLE IF NOT EXISTS account_store_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      initialized INTEGER NOT NULL DEFAULT 0,
      clean_index_version INTEGER,
      scratch_id TEXT
    );
    CREATE TABLE IF NOT EXISTS account_tool_events (
      sequence INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      line TEXT NOT NULL
    );
  `);
}

function readState(storage: DurableObjectStorage): AccountState | undefined {
  return storage.sql
    .exec<AccountState>(
      'SELECT initialized, clean_index_version, scratch_id FROM account_store_state WHERE singleton = 1',
    )
    .toArray()[0];
}

function hasSearchTables(storage: DurableObjectStorage): boolean {
  return (
    storage.sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name IN ('memories', 'memories_fts')`,
      )
      .one().count === 2
  );
}

function dropSearchTables(storage: DurableObjectStorage): void {
  // These tables are all derived; an old schema cannot be repaired by clearing rows.
  storage.transactionSync(() => {
    storage.sql.exec(`
      DROP TABLE IF EXISTS search_vocab;
      DROP TABLE IF EXISTS search_stems;
      DROP TABLE IF EXISTS search_tokens;
      DROP TABLE IF EXISTS memories_fts;
      DROP TABLE IF EXISTS memories;
    `);
  });
}

function scratchPath(id: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error('Invalid account scratch identifier.');
  }
  return `/tmp/memento-account-${id}`;
}

function assertDocumentPath(path: string): void {
  if (path === 'config.json') return;
  const [dir, file, ...rest] = path.split('/');
  if (
    (dir !== 'memories' && dir !== 'projects') ||
    !file?.endsWith('.md') ||
    file.startsWith('..') ||
    file.includes('\\') ||
    Array.from(file, (char) => char.charCodeAt(0)).some((code) => code < 32 || code === 127) ||
    Buffer.byteLength(file) > 255 ||
    rest.length
  ) {
    throw new Error('Invalid account document path.');
  }
}

class DocumentBudget {
  private count = 0;
  private bytes = 0;

  add(size: number): void {
    if (
      size > MAX_DOCUMENT_BYTES ||
      ++this.count > MAX_DOCUMENTS ||
      (this.bytes += size) > MAX_ACCOUNT_BYTES
    ) {
      throw new Error('Account documents exceed store capacity.');
    }
  }
}

function loadDocuments(storage: DurableObjectStorage): AccountDocument[] {
  // Check aggregate size without fetching the text of an oversized store into the isolate.
  const { count, bytes } = storage.sql
    .exec<{ count: number; bytes: number }>(
      'SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM account_documents',
    )
    .one();
  if (count > MAX_DOCUMENTS || bytes > MAX_ACCOUNT_BYTES) {
    throw new Error('Account documents exceed store capacity.');
  }
  const documents = storage.sql
    .exec<AccountDocument>('SELECT path, contents FROM account_documents ORDER BY path')
    .toArray();
  for (const { path } of documents) assertDocumentPath(path);
  return documents;
}

/** Internal export primitive; never returns log, search index, or auth rows. */
export function readAccountDocuments(storage: DurableObjectStorage): AccountDocument[] {
  ensureTables(storage);
  return loadDocuments(storage);
}

/** Internal import primitive. Caller supplies validated canonical records for one verified target. */
export async function replaceEmptyAccountDocuments(
  storage: DurableObjectStorage,
  documents: readonly AccountDocument[],
): Promise<void> {
  const incoming: Documents = new Map();
  const budget = new DocumentBudget();
  for (const { path, contents } of documents) {
    assertDocumentPath(path);
    budget.add(Buffer.byteLength(contents));
    if (incoming.has(path)) throw new Error('Duplicate account document path.');
    incoming.set(path, contents);
  }
  ensureTables(storage);
  storage.transactionSync(() => {
    const state = readState(storage);
    if (
      state?.initialized ||
      state?.scratch_id ||
      storage.sql.exec('SELECT 1 FROM account_documents LIMIT 1').toArray().length
    ) {
      throw new Error('The destination account store already exists.');
    }
    writeDocumentChanges(storage, new Map(), incoming);
    markInitialized(storage, null);
  });
  await storage.sync();
}

function writeDocumentChanges(
  storage: DurableObjectStorage,
  before: Documents,
  after: Documents,
): void {
  const deleted = [...before.keys()].filter((path) => !after.has(path));
  for (let start = 0; start < deleted.length; start += BATCH_SIZE) {
    const batch = deleted.slice(start, start + BATCH_SIZE);
    storage.sql.exec(
      `DELETE FROM account_documents WHERE path IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
  }
  const changed = [...after].filter(([path, contents]) => before.get(path) !== contents);
  for (let start = 0; start < changed.length; start += BATCH_SIZE) {
    const batch = changed.slice(start, start + BATCH_SIZE);
    storage.sql.exec(
      `INSERT INTO account_documents (path, contents) VALUES ${batch.map(() => '(?, ?)').join(',')}
       ON CONFLICT(path) DO UPDATE SET contents = excluded.contents`,
      ...batch.flat(),
    );
  }
}

function markInitialized(storage: DurableObjectStorage, cleanIndexVersion: number | null): void {
  storage.sql.exec(
    `INSERT INTO account_store_state (singleton, initialized, clean_index_version) VALUES (1, 1, ?)
     ON CONFLICT(singleton) DO UPDATE SET initialized = 1, clean_index_version = excluded.clean_index_version,
       scratch_id = NULL`,
    cleanIndexVersion,
  );
}

function writeEvents(storage: DurableObjectStorage, events: EventLine[]): void {
  if (!events.length) return;
  storage.sql.exec(
    `INSERT INTO account_tool_events (filename, line) VALUES ${events.map(() => '(?, ?)').join(',')}`,
    ...events.flatMap(({ filename, line }) => [filename, line]),
  );
  storage.sql.exec(
    `DELETE FROM account_tool_events WHERE sequence <= (
      SELECT sequence FROM account_tool_events ORDER BY sequence DESC LIMIT 1 OFFSET ?
    )`,
    MAX_LOG_EVENTS,
  );
}

async function hydrate(home: string, documents: Documents): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  for (const dir of DOCUMENT_DIRS) await mkdir(join(home, dir), { mode: 0o700 });
  for (const [path, contents] of documents) {
    const [dir, filename] = path.split('/');
    let local = path;
    // workerd's file URL normalization can alias names such as `x y.md` and
    // `x%20y.md`. Keep their original spellings in SQLite, not in its VFS.
    if (
      filename &&
      (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.startsWith(SCRATCH_FILENAME_PREFIX))
    ) {
      local = `${dir}/${SCRATCH_FILENAME_PREFIX}${aliases.size}.md`;
      aliases.set(local, path);
    }
    await writeFile(join(home, local), contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return aliases;
}

async function snapshot(home: string, aliases: ReadonlyMap<string, string>): Promise<Documents> {
  const budget = new DocumentBudget();
  const documents: Documents = new Map();
  const add = async (path: string, optional = false): Promise<void> => {
    assertDocumentPath(path);
    const file = join(home, path);
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (optional && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isFile()) throw new Error('Account documents must be regular files.');
    budget.add(info.size);
    documents.set(aliases.get(path) ?? path, await readFile(file, 'utf8'));
  };
  await add('config.json', true);
  for (const dir of DOCUMENT_DIRS) {
    const root = join(home, dir);
    if (!(await lstat(root)).isDirectory()) throw new Error('Invalid account document directory.');
    for (const file of await readdir(root)) {
      if (file.endsWith('.md')) await add(`${dir}/${file}`);
    }
  }
  return documents;
}

/** The account DO must serialize calls, including imports, and await this before replying. */
export async function withAccountStore<T>(
  storage: DurableObjectStorage,
  fn: (store: StoreContext) => Promise<T>,
): Promise<T> {
  ensureTables(storage);
  const before: Documents = new Map(
    loadDocuments(storage).map(({ path, contents }) => [path, contents]),
  );
  const state = readState(storage);
  if (state?.scratch_id) await removeScratch(scratchPath(state.scratch_id));
  const scratchId = randomUUID();
  const home = scratchPath(scratchId);
  const needsRebuild =
    state?.clean_index_version !== INDEX_SCHEMA_VERSION || !hasSearchTables(storage);
  // Mark the index dirty before any index writes. Record the scratch directory
  // separately for runtimes that retain /tmp across requests (e.g. local workerd).
  storage.sql.exec(
    `INSERT INTO account_store_state (singleton, clean_index_version, scratch_id) VALUES (1, NULL, ?)
     ON CONFLICT(singleton) DO UPDATE SET clean_index_version = NULL, scratch_id = excluded.scratch_id`,
    scratchId,
  );
  await storage.sync();

  await mkdir(home, { mode: 0o700 });
  let cleaned = false;
  try {
    const aliases = await hydrate(home, before);
    const config = loadConfig(home);

    const events: EventLine[] = [];
    let acceptingLogs = true;
    let failedOperation = false;
    if (needsRebuild) dropSearchTables(storage);
    const store = new StoreContext(config, MemoryIndex.fromDurableStorage(storage), () => {
      failedOperation = true;
    });
    const result = await withSerializedMemoryStore(config.paths.memories, () =>
      withAccountEventLog(
        config.paths.logs,
        (filename, line) => {
          if (
            acceptingLogs &&
            events.length < MAX_EVENTS_PER_REQUEST &&
            Buffer.byteLength(line) <= MAX_EVENT_BYTES
          ) {
            events.push({ filename, line });
          }
        },
        async () => {
          try {
            if (needsRebuild) {
              await rebuildIndexUnlocked(store.index, config.paths.memories);
            }
            return await fn(store);
          } finally {
            try {
              await store.close();
            } finally {
              acceptingLogs = false;
            }
          }
        },
      ),
    );
    const after = await snapshot(home, aliases);
    await removeScratch(home);
    cleaned = true;
    storage.transactionSync(() => {
      writeDocumentChanges(storage, before, after);
      writeEvents(storage, events);
      // The MCP layer can return a tool error without throwing out of the callback.
      markInitialized(storage, failedOperation ? null : INDEX_SCHEMA_VERSION);
    });
    await storage.sync();
    return result;
  } finally {
    if (!cleaned) await removeScratch(home).catch(() => {});
  }
}

function removeScratch(home: string): Promise<void> {
  return rm(home, { force: true, recursive: true });
}
