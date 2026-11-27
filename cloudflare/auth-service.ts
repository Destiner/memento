import type { DurableObjectStorage, SqlStorage } from '@cloudflare/workers-types';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type { BetterAuthOptions } from 'better-auth';
import {
  DummyDriver,
  Kysely,
  SqliteDialect,
  type CompiledQuery,
  type DatabaseConnection,
} from 'kysely';
import {
  createAuthServiceWithBackend,
  type AuthBackend,
  type AuthService,
  type AuthServiceOptions,
} from '../src/auth/core.js';
import { migrateAuth } from './auth-schema.js';

function execute(sql: SqlStorage, query: string, bindings: readonly unknown[]) {
  const cursor = sql.exec(query, ...bindings);
  const returnsRows = cursor.columnNames.length > 0;
  const rows = cursor.toArray();
  // changes() counts matched rows in the target table, not index writes or FK cascades.
  return {
    rows,
    changes: returnsRows ? 0 : sql.exec<{ n: number }>('SELECT changes() AS n').one().n,
  };
}

class DurableSqlDriver extends DummyDriver {
  constructor(private readonly sql: SqlStorage) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const sql = this.sql;
    return {
      async executeQuery<R>(query: CompiledQuery) {
        const { rows, changes } = execute(sql, query.sql, query.parameters);
        return { rows: rows as R[], numAffectedRows: BigInt(changes) };
      },
      async *streamQuery<R>(query: CompiledQuery) {
        for (const row of sql.exec(query.sql, ...query.parameters)) yield { rows: [row as R] };
      },
    };
  }

  override async beginTransaction(): Promise<never> {
    throw new Error('Use Durable Object storage transactions for auth');
  }
}

class DurableSqlDialect extends SqliteDialect {
  constructor(private readonly sql: SqlStorage) {
    super({
      database: () => {
        throw new Error('Use the Durable Object SQLite driver');
      },
    });
  }

  override createDriver() {
    return new DurableSqlDriver(this.sql);
  }
}

export function createWorkerAuthService(
  options: Omit<AuthServiceOptions, 'dataDir'>,
  storage: DurableObjectStorage,
): Promise<AuthService> {
  return createAuthServiceWithBackend(options, async (): Promise<AuthBackend> => {
    const sql = storage.sql;
    const db = new Kysely({ dialect: new DurableSqlDialect(sql) });
    const factory = kyselyAdapter(db, { type: 'sqlite', transaction: false });
    return {
      database: (config: BetterAuthOptions) => {
        const adapter = factory(config);
        // Better Auth can await between statements; transactionSync would commit too early.
        const transaction: typeof adapter.transaction = (fn) =>
          storage.transaction(() => fn(adapter));
        adapter.transaction = transaction;
        if (adapter.options)
          adapter.options.adapterConfig = { ...adapter.options.adapterConfig, transaction };
        return adapter;
      },
      migrate: async () => migrateAuth(storage),
      write: (query, ...params) => execute(sql, query, params).changes,
      count: (query) => sql.exec<{ n: number }>(query).one().n,
      atomic: (fn) => storage.transactionSync(fn),
      close: () => db.destroy(),
    };
  });
}
