import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { openStore, type StoreContext } from './store/context.js';

// No eviction: a request may still be borrowing any cached store.
export const MAX_OPEN_ACCOUNT_STORES = 128;
// Lowercase avoids aliasing accounts on case-insensitive filesystems.
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Account ids are opaque trusted-auth identifiers, never caller-supplied paths. */
export class AccountStores {
  private readonly dataDir: string;
  private readonly stores = new Map<string, Promise<StoreContext>>();
  private closing?: Promise<void>;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  get(accountId: string): Promise<StoreContext> {
    if (this.closing) return Promise.reject(new Error('Account stores are closed.'));
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
      return Promise.reject(new Error('Invalid account id.'));
    }
    const cached = this.stores.get(accountId);
    if (cached) return cached;
    if (this.stores.size >= MAX_OPEN_ACCOUNT_STORES) {
      return Promise.reject(new Error('Open account store limit reached.'));
    }
    const opening = this.open(accountId).catch((error: unknown) => {
      this.stores.delete(accountId);
      throw error;
    });
    this.stores.set(accountId, opening);
    return opening;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const results = await Promise.allSettled(
        [...this.stores.values()].map(async (opening) => (await opening).close()),
      );
      this.stores.clear();
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length) {
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Failed to close account stores.',
        );
      }
    })();
    return this.closing;
  }

  private async open(accountId: string): Promise<StoreContext> {
    await privateDirectory(this.dataDir);
    const root = await realpath(this.dataDir);
    const accounts = join(root, 'accounts');
    await privateDirectory(accounts);
    const home = join(accounts, accountId);
    await privateDirectory(home);
    // Covers config, SQLite files/sidecars, logs, and registry/memory files too.
    // Disk is service-owned; untrusted local writers are outside this boundary.
    await rejectSymlinks(home);
    return openStore(loadConfig(home));
  }
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Account storage must use real directories, not symlinks.');
  }
}

async function rejectSymlinks(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in account storage.');
    if (stat.isDirectory()) await rejectSymlinks(child);
  }
}
