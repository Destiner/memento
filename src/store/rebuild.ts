// Rebuild the derived search index from canonical markdown.
//
// The index is disposable: this routine is the recovery path after deletion,
// corruption, or a schema bump. It clears the index and re-inserts every memory
// found in `memories/`. It is internal — invoked on a startup mismatch, never a
// public tool.
//
// Rebuild is best-effort by design: a single unparseable or invalid file is
// skipped and counted rather than aborting the whole rebuild, so one bad record
// never takes search offline. Callers can surface `skipped` for operator review.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from './frontmatter.js';
import { assertInsideRoot } from './path-safety.js';
import { validateMemoryFrontmatter } from './memory-schema.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import type { MemoryIndex } from './search-index.js';

export interface RebuildResult {
  indexed: number;
  skipped: { file: string; reason: string }[];
}

export async function rebuildIndex(
  index: MemoryIndex,
  memoriesDir: string,
): Promise<RebuildResult> {
  return withMemoryMutationLock(memoriesDir, () => rebuildIndexUnlocked(index, memoriesDir));
}

export async function rebuildIndexUnlocked(
  index: MemoryIndex,
  memoriesDir: string,
): Promise<RebuildResult> {
  const files = await listMemoryFiles(memoriesDir);

  index.clear();

  const result: RebuildResult = { indexed: 0, skipped: [] };
  for (const file of files) {
    try {
      const path = join(memoriesDir, file);
      // A symlink escaping the memory root is store corruption, not a memory;
      // skip it rather than ingesting content from outside the store (§15).
      await assertInsideRoot(memoriesDir, path);
      const raw = await readFile(path, 'utf8');
      const { metadata, body } = parseFrontmatter(raw);
      const validated = validateMemoryFrontmatter(metadata);
      index.upsert(validated, body);
      result.indexed += 1;
    } catch (error) {
      result.skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}

async function listMemoryFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith('.md')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
