import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { migrateAuth } from './auth-schema.js';
import {
  AUTH_TABLES,
  insertAuthRows,
  validateAuthSnapshot,
  verifyAuthRows,
} from './snapshot-auth.js';

const stateTable = `CREATE TABLE IF NOT EXISTS mementoAuthSnapshotState (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
)`;

/** Seal the import window before normal ingress, even if auth has never held a user. */
export function markAuthIngressStarted(storage: DurableObjectStorage): void {
  storage.sql.exec(stateTable);
  storage.sql.exec('INSERT OR IGNORE INTO mementoAuthSnapshotState VALUES (1)');
}

/** Internal RPC primitive. Invoke under the auth DO's exclusive maintenance gate. */
export async function importAuthSnapshot(
  storage: DurableObjectStorage,
  snapshot: unknown,
  origin: string,
): Promise<true> {
  const sql = storage.sql;
  const read = (query: string) => sql.exec(query);
  const hasRows = (query: string) => sql.exec(query).toArray().length !== 0;
  try {
    const auth = validateAuthSnapshot(snapshot, origin);
    migrateAuth(storage);
    storage.transactionSync(() => {
      sql.exec(stateTable);
      if (
        hasRows('SELECT 1 FROM mementoAuthSnapshotState LIMIT 1') ||
        AUTH_TABLES.some(
          (table) => table !== 'oauthResource' && hasRows(`SELECT 1 FROM "${table}" LIMIT 1`),
        )
      ) {
        throw new Error('Auth destination already exists.');
      }
      // Better Auth may initialize before RPC dispatch. Only replace its unmodified
      // one-origin bootstrap row, and keep the source row's identity and timestamps.
      const resources = sql
        .exec<{ fresh: number }>(
          `SELECT CASE WHEN
        identifier = ? AND name = identifier AND accessTokenTtl IS NULL AND refreshTokenTtl IS NULL
        AND signingAlgorithm IS NULL AND signingKeyId IS NULL AND allowedScopes IS NULL
        AND (customClaims IS NULL OR customClaims = 'null')
        AND dpopBoundAccessTokensRequired = 0 AND disabled = 0 AND policyVersion = 1
        AND (metadata IS NULL OR metadata = 'null') AND createdAt IS NOT NULL AND createdAt = updatedAt
        THEN 1 ELSE 0 END AS fresh FROM oauthResource LIMIT 2`,
          `${origin}/mcp`,
        )
        .toArray();
      if (resources.length > 1 || (resources[0] && resources[0].fresh !== 1)) {
        throw new Error('Auth destination already exists.');
      }
      sql.exec('DELETE FROM oauthResource');
      insertAuthRows((query, ...values) => {
        sql.exec(query, ...values);
      }, auth);
      verifyAuthRows(read, auth);
      markAuthIngressStarted(storage);
    });
    await storage.sync();
    verifyAuthRows(read, auth);
  } catch {
    // SQLite and parser errors can include private identifiers or input values.
    throw new Error('Auth snapshot import refused or verification failed.');
  }
  return true;
}
