import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, opendir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_DOCUMENT_LIMITS, type AccountDocument } from '../cloudflare/account-store.js';
import { authMigrations } from '../cloudflare/auth-schema.js';
import {
  assertOrigin,
  AUTH_COLUMNS,
  AUTH_TABLES,
  insertAuthRows,
  MAX_AUTH_BYTES,
  MAX_AUTH_CELL_BYTES,
  MAX_AUTH_ROWS,
  readAuthTable,
  validateAuthSnapshot,
  verifyAuthRows,
} from '../cloudflare/snapshot-auth.js';
import {
  MAX_SNAPSHOT_ACCOUNTS,
  MAX_SNAPSHOT_BYTES,
  validateMigrationSnapshot,
  type MigrationSnapshot,
} from '../cloudflare/snapshot.js';
import { acquireServiceLock } from '../src/service-lock.js';

const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_TREE_ENTRIES = 16_384;
const MAX_DERIVED_DEPTH = 4;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class ExportError extends Error {}
const refuse = (message: string): never => {
  throw new ExportError(message);
};

function absolute(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) refuse('Use normalized absolute paths.');
  return path;
}

async function realDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await realDirectory(parent);
  if (!(await lstat(path)).isDirectory()) refuse('A migration directory is not a real directory.');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function readAuth(path: string, origin: string) {
  const uri = pathToFileURL(path);
  uri.searchParams.set('immutable', '1'); // Requires a stopped writer and a clean checkpoint.
  const source = new DatabaseSync(uri.href, { readOnly: true });
  try {
    source.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; BEGIN');
    const read = (query: string) => source.prepare(query).all();
    if (
      read('PRAGMA encoding')[0]?.encoding !== 'UTF-8' ||
      read('PRAGMA quick_check(1)')[0]?.quick_check !== 'ok' ||
      read('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').length
    ) {
      refuse('Invalid source SQLite database.');
    }
    const schema = read(`SELECT name, type FROM sqlite_schema WHERE type != 'index' LIMIT 32`);
    if (
      schema.length !== AUTH_TABLES.length ||
      schema.some(
        ({ name, type }) => type !== 'table' || !AUTH_TABLES.some((table) => table === name),
      )
    ) {
      refuse('Unexpected source auth schema.');
    }
    const target = new DatabaseSync(':memory:');
    try {
      target.exec(authMigrations[0]!);
      const check = (query: string) => target.prepare(query).all();
      let rows = 0;
      let bytes = 0;
      const auth = Object.fromEntries(
        AUTH_TABLES.map((table) => {
          const columns = AUTH_COLUMNS[table];
          const canonical = (result: Record<string, unknown>[]) =>
            result
              .map(({ name, type, notnull, pk, hidden }) =>
                JSON.stringify([name, String(type).toLowerCase(), notnull, pk, hidden]),
              )
              .sort();
          const describe = `PRAGMA table_xinfo("${table}")`;
          if (
            JSON.stringify(canonical(read(describe))) !== JSON.stringify(canonical(check(describe)))
          ) {
            refuse('Unexpected source auth columns.');
          }
          const lengths = columns.map((col) => `coalesce(length(CAST("${col}" AS BLOB)), 0)`);
          const [size] =
            read(`SELECT count(*) AS rows, coalesce(sum(${lengths.join(' + ')}), 0) AS bytes,
          coalesce(max(max(${lengths.join(', ')})), 0) AS cell FROM "${table}"`);
          rows += Number(size!.rows);
          bytes += Number(size!.bytes);
          if (
            rows > MAX_AUTH_ROWS ||
            bytes > MAX_AUTH_BYTES ||
            Number(size!.cell) > MAX_AUTH_CELL_BYTES
          ) {
            refuse('Auth snapshot exceeds capacity.');
          }
          return [table, readAuthTable(read, table)];
        }),
      );
      const validated = validateAuthSnapshot(auth, origin);
      // A fresh copy catches constraint, affinity and FK differences before publishing an export.
      target.exec('BEGIN');
      insertAuthRows((query, ...values) => {
        target
          .prepare(query)
          .run(
            ...values.map((value): SQLInputValue =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          );
      }, validated);
      verifyAuthRows(check, validated);
      target.exec('ROLLBACK');
      return validated;
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
}

async function readDocument(path: string, size: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== size)
      refuse('Invalid source document.');
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (offset !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      refuse('Source document changed during export.');
    }
    return decoder.decode(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
}

/** Read a stopped, service-owned, checkpointed Node data directory. Never call on a live copy. */
export async function exportSnapshot(dataDir: string, origin: string): Promise<MigrationSnapshot> {
  try {
    assertOrigin(origin);
    const root = absolute(dataDir);
    await realDirectory(root);
    const lock = join(root, '.runtime-lock.sqlite');
    if (await exists(lock)) {
      const entry = await lstat(lock);
      if (!entry.isFile() || entry.nlink !== 1) refuse('Invalid service lock.');
    }
    for (const sidecar of ['-wal', '-shm', '-journal']) {
      if (await exists(`${lock}${sidecar}`)) refuse('Source service lock has a SQLite sidecar.');
    }
    const release = await acquireServiceLock(root).catch(() =>
      refuse('Cannot acquire the source service lock.'),
    );
    try {
      let visited = 0;
      async function entries(path: string): Promise<string[]> {
        if (!(await lstat(path)).isDirectory()) refuse('Unexpected source directory.');
        const list: string[] = [];
        for await (const entry of await opendir(path)) {
          if (++visited > MAX_TREE_ENTRIES) refuse('Source tree exceeds capacity.');
          list.push(entry.name);
        }
        return list.sort();
      }
      async function inspectDerived(path: string, depth = 0): Promise<void> {
        if (depth > MAX_DERIVED_DEPTH) refuse('Unexpected derived directory nesting.');
        for (const name of await entries(path)) {
          const child = join(path, name);
          const entry = await lstat(child);
          if (entry.isDirectory()) await inspectDerived(child, depth + 1);
          else if (!entry.isFile()) refuse('Unexpected entry in source derived data.');
        }
      }

      for (const name of await entries(root)) {
        if (
          ![
            'accounts',
            'auth.sqlite',
            '.runtime-lock.sqlite',
            '.runtime-lock.sqlite-journal',
          ].includes(name)
        ) {
          refuse('Unexpected source root entry or uncheckpointed SQLite database.');
        }
      }
      const db = join(root, 'auth.sqlite');
      const dbEntry = await lstat(db);
      if (!dbEntry.isFile() || dbEntry.nlink !== 1 || dbEntry.size > MAX_DB_BYTES)
        refuse('Invalid source auth file.');
      const auth = readAuth(db, origin);
      if (auth.user.length > MAX_SNAPSHOT_ACCOUNTS)
        refuse('Snapshot account count exceeds capacity.');
      const accountsRoot = join(root, 'accounts');
      const users = new Set(auth.user.map(({ id }) => id));
      const homes = new Map<string, AccountDocument[]>();
      let snapshotBytes = Buffer.byteLength(
        JSON.stringify({ version: 1, origin, auth, accounts: [] }),
      );
      if (await exists(accountsRoot)) {
        for (const id of await entries(accountsRoot)) {
          if (!users.has(id)) refuse('A source account directory has no matching auth user.');
          const documents: AccountDocument[] = [];
          const home = join(accountsRoot, id);
          let accountBytes = 0;
          const add = async (path: string) => {
            const file = join(home, path);
            const info = await lstat(file);
            const { maxDocuments, maxDocumentBytes, maxAccountBytes } = ACCOUNT_DOCUMENT_LIMITS;
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.size > maxDocumentBytes ||
              documents.length >= maxDocuments ||
              (accountBytes += info.size) > maxAccountBytes ||
              snapshotBytes + info.size > MAX_SNAPSHOT_BYTES
            )
              refuse('Invalid or oversized source document.');
            const document = { path, contents: await readDocument(file, info.size) };
            snapshotBytes += Buffer.byteLength(JSON.stringify(document)) + 1;
            if (snapshotBytes > MAX_SNAPSHOT_BYTES) refuse('Migration snapshot exceeds capacity.');
            documents.push(document);
          };
          for (const name of await entries(home)) {
            const path = join(home, name);
            if (name === 'config.json') await add(name);
            else if (name === 'projects' || name === 'memories') {
              for (const file of await entries(path)) await add(`${name}/${file}`);
            } else if (['index', 'logs', 'dashboard', '.memento-locks'].includes(name)) {
              await inspectDerived(path);
            } else refuse('Unexpected source account entry.');
          }
          homes.set(id, documents);
        }
      }
      return validateMigrationSnapshot(
        {
          version: 1,
          origin,
          auth,
          accounts: auth.user.map(({ id }) => ({ id, documents: homes.get(id) ?? [] })),
        },
        origin,
      );
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new Error('Invalid or unreadable migration source.');
  }
}

/** Publish only a complete file, with exclusive creation and no symlink traversal. */
async function writeSnapshot(path: string, source: string, bytes: Buffer): Promise<void> {
  absolute(path);
  const rel = relative(source, path);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    refuse('The snapshot destination must be outside the source directory.');
  }
  const parent = dirname(path);
  await realDirectory(parent);
  const stage = await mkdtemp(join(parent, '.memento-cf-export-'));
  try {
    const temp = join(stage, 'snapshot');
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temp, path);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const { MEMENTO_DATA_DIR, MEMENTO_PUBLIC_ORIGIN, MEMENTO_SNAPSHOT_FILE } = process.env;
  const args = process.argv.slice(2);
  const stdout = args.length === 1 && args[0] === '--stdout';
  if (
    !MEMENTO_DATA_DIR ||
    !MEMENTO_PUBLIC_ORIGIN ||
    (stdout ? MEMENTO_SNAPSHOT_FILE || process.stdout.isTTY : args.length || !MEMENTO_SNAPSHOT_FILE)
  ) {
    refuse(
      'Set MEMENTO_DATA_DIR and MEMENTO_PUBLIC_ORIGIN; choose MEMENTO_SNAPSHOT_FILE or explicit non-TTY --stdout.',
    );
  }
  const snapshot = await exportSnapshot(MEMENTO_DATA_DIR!, MEMENTO_PUBLIC_ORIGIN!);
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  if (stdout) {
    await new Promise<void>((done, fail) =>
      process.stdout.write(bytes, (error?: Error | null) => (error ? fail(error) : done())),
    );
  } else {
    await writeSnapshot(MEMENTO_SNAPSHOT_FILE!, MEMENTO_DATA_DIR!, bytes);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof ExportError ? error.message : 'Cloudflare snapshot export failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
