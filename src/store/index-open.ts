// Open the derived index for a home directory, rebuilding it when it is stale.
//
// The index is non-authoritative (§6, §12), so the safe default is: trust an
// existing index whose recorded schema version matches the code, and otherwise
// discard it and rebuild from markdown. A schema bump changes the table shape,
// so a mismatch drops the database file entirely rather than trying to migrate.
//
// This runs at startup and is internal — there is no public "rebuild" command.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { INDEX_SCHEMA_VERSION } from './index-schema.js';
import { rebuildIndex, type RebuildResult } from './rebuild.js';
import { MemoryIndex } from './search-index.js';

const DB_FILENAME = 'memory.sqlite';
const VERSION_FILENAME = 'schema_version.json';

export interface OpenIndexOptions {
  indexDir: string;
  memoriesDir: string;
}

export interface OpenIndexResult {
  index: MemoryIndex;
  rebuilt: boolean;
  rebuild: RebuildResult | null;
}

export async function openIndex(options: OpenIndexOptions): Promise<OpenIndexResult> {
  await mkdir(options.indexDir, { recursive: true });

  const dbPath = join(options.indexDir, DB_FILENAME);
  const versionPath = join(options.indexDir, VERSION_FILENAME);
  const stale = existsSync(dbPath)
    ? (await readSchemaVersion(versionPath)) !== INDEX_SCHEMA_VERSION
    : true;

  if (stale) {
    await dropDatabase(dbPath);
  }

  const index = new MemoryIndex(dbPath);

  if (!stale) {
    return { index, rebuilt: false, rebuild: null };
  }

  const rebuild = await rebuildIndex(index, options.memoriesDir);
  await writeFile(versionPath, `${JSON.stringify({ schema_version: INDEX_SCHEMA_VERSION })}\n`);
  return { index, rebuilt: true, rebuild };
}

// Read the recorded index schema version, treating a missing or malformed file
// as "unknown" so it triggers a rebuild.
async function readSchemaVersion(versionPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(versionPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { schema_version?: unknown };
    return typeof parsed.schema_version === 'number' ? parsed.schema_version : null;
  } catch {
    return null;
  }
}

// Remove the SQLite database and its WAL sidecars so a fresh schema is created.
async function dropDatabase(dbPath: string): Promise<void> {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) => rm(path, { force: true })),
  );
}
