import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Kernel-owned lock: released on crashes, shared by serving and offline imports. */
export async function acquireServiceLock(dataDir: string): Promise<() => void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if ((await lstat(dataDir)).isSymbolicLink())
    throw new Error('Data directory must not be a symlink.');
  const path = join(dataDir, '.runtime-lock.sqlite');
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Runtime lock must not be a symlink.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error(
      'The data directory is in use. Stop the service before importing or starting another instance.',
    );
  }
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      lock.close();
    }
  };
}
