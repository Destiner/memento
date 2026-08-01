import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MementoError } from '../errors.js';

export async function withMemoryMutationLock<T>(
  memoriesDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(dirname(memoriesDir), '.memento-locks');
  const identity = createHash('sha256').update(resolve(memoriesDir)).digest('hex').slice(0, 24);
  const lockPath = join(lockRoot, `memory-store-${identity}.sqlite`);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await chmod(lockRoot, 0o700);
  const database = new DatabaseSync(lockPath);
  await chmod(lockPath, 0o600);
  database.exec('PRAGMA busy_timeout = 0;');
  try {
    database.exec('BEGIN IMMEDIATE;');
  } catch (error) {
    try {
      database.close();
    } catch {
      // Closing still releases SQLite's process-owned lock on process exit.
    }
    if (String(error).includes('SQLITE_BUSY') || String(error).includes('database is locked')) {
      throw new MementoError(
        'invalid_request',
        'The memory store is already being mutated; retry after the active operation completes.',
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Closing the connection below is the fallback lock release.
    }
    try {
      database.close();
    } catch {
      // Never turn a completed durable mutation into a retryable error.
    }
  }
}
