import { Buffer } from 'node:buffer';
import { authMigrations } from './auth-schema.js';
import { MAX_RPC_ESTIMATE_BYTES } from './snapshot-limits.js';

// The wire layout is frozen to migration v1; tables are in FK insertion order.
export const AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'oauthClient',
  'oauthResource',
  'oauthClientResource',
  'oauthRefreshToken',
  'oauthAccessToken',
  'oauthConsent',
  'oauthClientAssertion',
] as const;
export type AuthTable = (typeof AUTH_TABLES)[number];
type Column = {
  name: string;
  affinity: 'text' | 'integer' | 'date';
  required: boolean;
  unique: boolean;
  reference?: { table: AuthTable; column: string };
};
const AUTH_LAYOUT = Object.fromEntries(
  AUTH_TABLES.map((table) => {
    const ddl = authMigrations[0]!
      .split('\n')
      .find((line) => line.startsWith(`create table "${table}" (`));
    if (!ddl) throw new Error('Missing v1 auth table.');
    return [
      table,
      [...ddl.matchAll(/(?:\(|, )"(\w+)" (text|integer|date)\b([^,]*)/g)].map(
        ([, name, affinity, constraints]) => {
          const reference = /references "(\w+)" \("(\w+)"\)/.exec(constraints!);
          return {
            name,
            affinity,
            required: /\bnot null\b/.test(constraints!),
            unique: /\b(?:primary key|unique)\b/.test(constraints!),
            reference: reference && { table: reference[1], column: reference[2] },
          };
        },
      ),
    ];
  }),
) as Record<AuthTable, Column[]>;
export const AUTH_COLUMNS = Object.fromEntries(
  AUTH_TABLES.map((table) => [table, AUTH_LAYOUT[table].map(({ name }) => name)]),
) as Record<AuthTable, string[]>;

export type AuthCell = null | string | number | { integer: string } | { blob: string };
export type AuthRow = { id: string } & Record<string, AuthCell>;
export type AuthSnapshot = Record<AuthTable, AuthRow[]>;
export const MAX_AUTH_ROWS = 8_192;
export const MAX_AUTH_BYTES = 4 * 1024 * 1024;
export const MAX_AUTH_CELL_BYTES = 256 * 1024;
const MAX_SQL_ROW_BYTES = 8_000_000;
const MAX_SQL_TEXT_BYTES = 100_000;
const MAX_SQL_BINDS = 100;
const MAX_SQL_COLUMNS = 100;
export const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function assertOrigin(origin: string): void {
  const url = typeof origin === 'string' && origin.length <= 2048 ? URL.parse(origin) : null;
  if (
    !url ||
    url.origin !== origin ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error('Invalid migration origin.');
  }
}

function validCell(value: unknown): value is AuthCell {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string')
    return (
      value.length <= MAX_AUTH_CELL_BYTES &&
      Buffer.byteLength(value) <= MAX_AUTH_CELL_BYTES &&
      Buffer.from(value).toString() === value
    );
  if (!record(value)) return false;
  if (
    exactKeys(value, ['integer']) &&
    typeof value.integer === 'string' &&
    value.integer.length <= 20 &&
    /^(0|-?[1-9]\d*)$/.test(value.integer)
  ) {
    const n = BigInt(value.integer);
    return n >= -(1n << 63n) && n < 1n << 63n;
  }
  if (
    exactKeys(value, ['blob']) &&
    typeof value.blob === 'string' &&
    value.blob.length <= Math.ceil(MAX_AUTH_CELL_BYTES / 3) * 4
  ) {
    const bytes = Buffer.from(value.blob, 'base64');
    return bytes.length <= MAX_AUTH_CELL_BYTES && bytes.toString('base64') === value.blob;
  }
  return false;
}

// INTEGER and DATE (NUMERIC) affinity coerce decimal text and in-range integral
// reals. SQLite's numeric parser stops at the first NUL in a TEXT value.
const sqliteDecimal = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\t\n\v\f\r ]*$/;

function hasStoredAffinity(cell: AuthCell, { affinity, required }: Column): boolean {
  if (cell === null) return !required;
  if (affinity === 'text')
    return typeof cell === 'string' || (typeof cell === 'object' && 'blob' in cell);
  if (typeof cell === 'string') return !sqliteDecimal.test(cell.split('\0', 1)[0]!);
  if (typeof cell === 'number')
    return !Number.isInteger(cell) || cell <= -(2 ** 63) || cell >= 2 ** 63;
  return true;
}

function storedCellBytes(cell: AuthCell): number {
  if (cell === null) return 0;
  if (typeof cell === 'string') return Buffer.byteLength(cell);
  if (typeof cell === 'object' && 'blob' in cell) return Buffer.byteLength(cell.blob, 'base64');
  return 8;
}

function validateAuthReferences(auth: AuthSnapshot): void {
  const invalid = () => new Error('Invalid auth snapshot constraints.');
  const unique = new Map<string, Set<string>>();
  for (const table of AUTH_TABLES) {
    for (const { name, unique: indexed } of AUTH_LAYOUT[table]) {
      if (!indexed) continue;
      const values = new Set<string>();
      for (const row of auth[table]) {
        const cell = row[name]!;
        if (cell === null) continue;
        const key = JSON.stringify(cell);
        if (values.has(key)) throw invalid();
        values.add(key);
      }
      unique.set(`${table}.${name}`, values);
    }
  }
  for (const table of AUTH_TABLES) {
    for (const { name, reference } of AUTH_LAYOUT[table]) {
      if (!reference) continue;
      const values = unique.get(`${reference.table}.${reference.column}`)!;
      for (const row of auth[table]) {
        const cell = row[name]!;
        if (cell !== null && !values.has(JSON.stringify(cell))) throw invalid();
      }
    }
  }
  // v1's only composite unique index, in addition to the inline constraints.
  const pairs = new Set<string>();
  for (const { clientId, resourceId } of auth.oauthClientResource) {
    const pair = JSON.stringify([clientId, resourceId]);
    if (pairs.has(pair)) throw invalid();
    pairs.add(pair);
  }
}

export function validateAuthSnapshot(value: unknown, origin: string): AuthSnapshot {
  assertOrigin(origin);
  const invalid = () => new Error('Invalid auth snapshot.');
  if (!record(value) || !exactKeys(value, AUTH_TABLES)) throw invalid();
  let count = 0;
  let rpcFraming = 1024;
  // Exact compact JSON size; row punctuation is counted as each bounded cell is visited.
  let bytes = Buffer.byteLength(
    JSON.stringify(Object.fromEntries(AUTH_TABLES.map((table) => [table, []]))),
  );
  for (const table of AUTH_TABLES) {
    const rows = value[table];
    if (!Array.isArray(rows) || (count += rows.length) > MAX_AUTH_ROWS) throw invalid();
    const columns = AUTH_LAYOUT[table];
    bytes += Math.max(0, rows.length - 1);
    for (const row of rows as unknown[]) {
      if (
        !record(row) ||
        !exactKeys(row, AUTH_COLUMNS[table]) ||
        typeof row.id !== 'string' ||
        !row.id ||
        (table === 'user' && !ACCOUNT_ID.test(row.id))
      )
        throw invalid();
      bytes += 1; // braces minus the nonexistent trailing comma
      rpcFraming += 64 + 48 * columns.length;
      // SQLite record header: a length varint and one serial-type varint per column.
      let rowBytes = 9 * (1 + columns.length);
      for (const column of columns) {
        const cell = row[column.name];
        if (!validCell(cell) || !hasStoredAffinity(cell, column)) throw invalid();
        rowBytes += storedCellBytes(cell);
        bytes += Buffer.byteLength(JSON.stringify(cell)) + column.name.length + 4;
        // Allow two bytes per code unit plus framing for rows, keys and tagged cells.
        if (
          bytes > MAX_AUTH_BYTES ||
          2 * bytes + rpcFraming > MAX_RPC_ESTIMATE_BYTES ||
          rowBytes > MAX_SQL_ROW_BYTES
        )
          throw invalid();
      }
    }
  }
  const auth = value as AuthSnapshot;
  const canonical = `${origin}/mcp`;
  const allowed = new Set([canonical]);
  // This exception is for snapshot preservation only, not live OAuth audiences.
  if (origin === 'https://memento.destiner.io') {
    allowed.add('https://memento-o9bz.onrender.com/mcp');
  }
  if (
    !auth.oauthResource.some(({ identifier }) => identifier === canonical) ||
    auth.oauthResource.some(
      ({ identifier }) => typeof identifier !== 'string' || !allowed.has(identifier),
    )
  ) {
    throw new Error('Auth snapshot does not match the migration resource.');
  }
  validateAuthReferences(auth);
  return auth;
}

export type SqlValue = null | number | string | ArrayBuffer | Uint8Array;
export type ReadSql = (query: string) => Iterable<Record<string, unknown>>;
export type WriteSql = (query: string, ...values: SqlValue[]) => void;

function checkedStatement(query: string, bindings = 0): string {
  if (Buffer.byteLength(query) > MAX_SQL_TEXT_BYTES || bindings > MAX_SQL_BINDS) {
    throw new Error('Auth snapshot SQL exceeds storage limits.');
  }
  return query;
}

function authSelect(table: AuthTable): string {
  const columns = AUTH_COLUMNS[table];
  if (columns.length * 2 > MAX_SQL_COLUMNS)
    throw new Error('Auth snapshot SQL exceeds storage limits.');
  const select = columns.flatMap((key, i) => [
    `typeof("${key}") AS t${i}`,
    `CASE typeof("${key}") WHEN 'integer' THEN CAST("${key}" AS TEXT)
     WHEN 'text' THEN CAST("${key}" AS BLOB) ELSE "${key}" END AS v${i}`,
  ]);
  return checkedStatement(`SELECT ${select.join(', ')} FROM "${table}" ORDER BY id`);
}

function authInsert(table: AuthTable, placeholders: string[]): string {
  return checkedStatement(
    `INSERT INTO "${table}" (${AUTH_COLUMNS[table].map((key) => `"${key}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
    placeholders.length,
  );
}

// Check the fixed SQL shape before import can start, using the longest placeholder.
for (const table of AUTH_TABLES) {
  authInsert(
    table,
    AUTH_COLUMNS[table].map(() => 'CAST(? AS INTEGER)'),
  );
  authSelect(table);
}

export function readAuthTable(read: ReadSql, table: AuthTable): AuthRow[] {
  const columns = AUTH_COLUMNS[table];
  return Array.from(
    read(authSelect(table)),
    (row) =>
      Object.fromEntries(
        columns.map((key, i) => {
          const v = row[`v${i}`];
          let cell: AuthCell;
          switch (row[`t${i}`]) {
            case 'integer':
              cell = { integer: v as string };
              break;
            case 'blob':
              cell = {
                blob: Buffer.from(
                  v instanceof ArrayBuffer ? new Uint8Array(v) : (v as Uint8Array),
                ).toString('base64'),
              };
              break;
            case 'text': {
              // Reading via BLOB avoids driver-level truncation at embedded NULs.
              cell = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                v as Uint8Array | ArrayBuffer,
              );
              break;
            }
            case 'real':
              cell = v as number;
              break;
            default:
              cell = null;
          }
          return [key, cell];
        }),
      ) as AuthRow,
  );
}

export function insertAuthRows(write: WriteSql, auth: AuthSnapshot): void {
  for (const table of AUTH_TABLES) {
    const columns = AUTH_COLUMNS[table];
    for (const row of auth[table]) {
      const values: SqlValue[] = [];
      const placeholders = columns.map((column) => {
        const cell = row[column]!;
        if (
          typeof cell === 'string' ||
          (cell !== null && typeof cell === 'object' && 'blob' in cell)
        ) {
          const bytes =
            typeof cell === 'string' ? Buffer.from(cell, 'utf8') : Buffer.from(cell.blob, 'base64');
          values.push(Uint8Array.from(bytes).buffer);
          return typeof cell === 'string' ? 'CAST(? AS TEXT)' : '?';
        }
        if (cell !== null && typeof cell === 'object') {
          values.push(cell.integer);
          return 'CAST(? AS INTEGER)';
        }
        values.push(cell);
        return typeof cell === 'number' ? 'CAST(? AS REAL)' : '?';
      });
      write(authInsert(table, placeholders), ...values);
    }
  }
}

export function verifyAuthRows(read: ReadSql, auth: AuthSnapshot): void {
  const violations = read('PRAGMA foreign_key_check')[Symbol.iterator]();
  if (!violations.next().done) {
    violations.return?.();
    throw new Error('Invalid auth references.');
  }
  for (const table of AUTH_TABLES) {
    const persisted = readAuthTable(read, table);
    const expected = new Map(auth[table].map((row) => [row.id, row]));
    if (
      persisted.length !== expected.size ||
      persisted.some((row) => {
        const original = expected.get(row.id);
        return (
          !original ||
          AUTH_COLUMNS[table].some(
            (key) => JSON.stringify(row[key]) !== JSON.stringify(original[key]),
          )
        );
      })
    )
      throw new Error('Auth snapshot verification failed.');
  }
}
