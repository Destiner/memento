type SqlParam = string | number;

export interface DurableSearchStorage {
  sql: {
    exec(
      query: string,
      ...bindings: SqlParam[]
    ): Iterable<Record<string, unknown>> & {
      // Some workerd versions do not expose cursor disposal.
      close?(): void;
    };
  };
  transactionSync<T>(fn: () => T): T;
}

export interface SearchDatabase {
  readonly scratchSchema: 'main' | 'temp';
  exec(query: string, ...bindings: SqlParam[]): void;
  rows<T>(query: string, ...bindings: SqlParam[]): Iterable<T>;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openNodeSearchDatabase(location: string): SearchDatabase {
  // Loading SQLite here keeps this module importable in Workers without nodejs_compat.
  const sqlite = typeof process !== 'undefined' && process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('Use MemoryIndex.fromDurableStorage in Workers.');
  const db = new sqlite.DatabaseSync(location);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return {
    scratchSchema: 'temp',
    exec(query, ...bindings) {
      db.prepare(query).run(...bindings);
    },
    rows<T>(query: string, ...bindings: SqlParam[]) {
      return db.prepare(query).iterate(...bindings) as Iterable<T>;
    },
    transaction(fn) {
      db.exec('BEGIN;');
      try {
        const result = fn();
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

export function openDurableSearchDatabase(storage: DurableSearchStorage): SearchDatabase {
  return {
    scratchSchema: 'main',
    exec(query, ...bindings) {
      storage.sql.exec(query, ...bindings);
    },
    *rows<T>(query: string, ...bindings: SqlParam[]) {
      const cursor = storage.sql.exec(query, ...bindings);
      try {
        for (const row of cursor) yield row as T;
      } finally {
        cursor.close?.();
      }
    },
    transaction: (fn) => storage.transactionSync(fn),
    // The storage connection belongs to the Durable Object runtime.
    close() {},
  };
}
