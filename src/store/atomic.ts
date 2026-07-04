// Atomic file writes for the canonical store (§9.1, §12).
//
// A memory file must never be observed half-written: readers and the index
// treat markdown as authoritative. We write to a uniquely-named temp file in
// the same directory, fsync it, then rename over the target — rename is atomic
// within a filesystem, so a concurrent reader sees either the old file or the
// complete new one. Directory fsync is best-effort ("fsync where practical").

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Create a directory (and parents) if absent. Idempotent.
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// Durably write `contents` to `path`, creating parent directories as needed.
// The write is atomic with respect to concurrent readers of `path`.
export async function atomicWrite(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }

  await fsyncDir(dir);
}

async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Best-effort: some platforms disallow fsync on a directory handle.
  } finally {
    await handle?.close();
  }
}
