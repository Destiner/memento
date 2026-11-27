import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { createAuthServiceWithBackend, type AuthServiceOptions, type AuthService } from './core.js';

export type { AuthIdentity, AuthService, AuthServiceOptions } from './core.js';

export function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  return createAuthServiceWithBackend(options, async () => {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const path = join(options.dataDir, 'auth.sqlite');
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    } catch (error) {
      db.close();
      throw error;
    }
    return {
      database: db,
      migrate: async (config) => (await getMigrations(config)).runMigrations(),
      write: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
      count: (sql) => Number(db.prepare(sql).get()!.n),
      atomic: (fn) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          fn();
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      close: () => db.close(),
    };
  });
}
