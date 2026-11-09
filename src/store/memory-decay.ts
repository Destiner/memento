import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_MEMORY_RETENTION_DAYS, type MementoConfig } from '../config.js';
import { atomicWrite } from './atomic.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { orderMemoryMetadata } from './memory-fields.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import { validateMemoryFrontmatter, type MemoryRecord } from './memory-schema.js';
import { assertInsideRoot } from './path-safety.js';
import { rebuildIndexUnlocked } from './rebuild.js';
import type { MemoryIndex } from './search-index.js';
import { isoSeconds } from './time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryDecayOptions {
  memoriesDir: string;
  index: MemoryIndex;
  config: Pick<MementoConfig, 'memory_archive_after_days' | 'memory_delete_after_days'>;
  now?: number;
}

export interface MemoryDecayResult {
  archived: number;
  deleted: number;
  initialized: number;
  skipped: { file: string; reason: string }[];
}

interface StoredMemory {
  file: string;
  path: string;
  record: MemoryRecord;
  body: string;
}

/** Markdown owns retention state; a missing/rebuilt index cannot reset a timer. */
export async function decayMemories(options: MemoryDecayOptions): Promise<MemoryDecayResult> {
  for (const key of ['memory_archive_after_days', 'memory_delete_after_days'] as const) {
    const value = options.config[key];
    if (!Number.isInteger(value) || value < 1 || value > MAX_MEMORY_RETENTION_DAYS) {
      throw new Error(`${key} must be an integer between 1 and ${MAX_MEMORY_RETENTION_DAYS}.`);
    }
  }
  return withMemoryMutationLock(options.memoriesDir, async () => {
    const now = options.now ?? Date.now();
    const timestamp = isoSeconds(now);
    const result: MemoryDecayResult = { archived: 0, deleted: 0, initialized: 0, skipped: [] };
    const memories = await loadMemories(options.memoriesDir, result);
    const idCounts = new Map<string, number>();
    for (const { record } of memories) {
      idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
    }

    for (const { file, path, record, body } of memories) {
      // Ambiguous hand-edited stores need repair, not destructive guesswork.
      if (idCounts.get(record.id)! > 1) {
        result.skipped.push({ file, reason: `Duplicate memory id: ${record.id}` });
        continue;
      }
      // A process may have stopped after writing a transition but before indexing it.
      if (options.index.statusOf(record.id) !== record.status) {
        options.index.upsert(record, body);
      }
      if (record.status === 'active') {
        const lastAccess = Date.parse(record.last_accessed_at ?? record.created_at);
        if (now - lastAccess < options.config.memory_archive_after_days * DAY_MS) continue;
        record.status = 'archived';
        record.archive_source = 'decay';
        record.archive_reason = `No explicit read for ${options.config.memory_archive_after_days} days.`;
        // Never backdate: even after long downtime, give the full archived grace period.
        record.archived_at = timestamp;
        record.updated_at = timestamp;
        await persist(path, record, body, options);
        result.archived++;
      } else if (record.archived_at === undefined) {
        // Old files do not say when archiving happened. Start safely, not at updated_at.
        record.archived_at = timestamp;
        record.archive_source ??= 'manual';
        await persist(path, record, body, options);
        result.initialized++;
      } else {
        const lastAccess = Date.parse(record.last_accessed_at ?? record.created_at);
        const deletionStart = Math.max(Date.parse(record.archived_at), lastAccess);
        if (now - deletionStart < options.config.memory_delete_after_days * DAY_MS) continue;
        // Remove derived content first. A crash before unlink leaves a file the next
        // sweep can retry, never an indexed body whose source has been deleted.
        try {
          options.index.remove(record.id);
        } catch {
          await rebuildIndexUnlocked(options.index, options.memoriesDir);
          options.index.remove(record.id);
        }
        try {
          await unlink(path);
        } catch (error) {
          await rebuildIndexUnlocked(options.index, options.memoriesDir);
          throw error;
        }
        result.deleted++;
      }
    }
    return result;
  });
}

async function persist(
  path: string,
  record: MemoryRecord,
  body: string,
  options: MemoryDecayOptions,
): Promise<void> {
  await atomicWrite(path, serializeFrontmatter(orderMemoryMetadata(record), body));
  try {
    options.index.upsert(record, body);
  } catch (error) {
    const rebuilt = await rebuildIndexUnlocked(options.index, options.memoriesDir);
    if (rebuilt.skipped.some((entry) => join(options.memoriesDir, entry.file) === path))
      throw error;
  }
}

async function loadMemories(
  memoriesDir: string,
  result: MemoryDecayResult,
): Promise<StoredMemory[]> {
  let entries;
  try {
    entries = await readdir(memoriesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const memories: StoredMemory[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue;
    try {
      if (!entry.isFile()) throw new Error('Retention only mutates regular memory files.');
      const path = join(memoriesDir, entry.name);
      await assertInsideRoot(memoriesDir, path);
      const { metadata, body } = parseFrontmatter(await readFile(path, 'utf8'));
      memories.push({ file: entry.name, path, record: validateMemoryFrontmatter(metadata), body });
    } catch (error) {
      result.skipped.push({ file: entry.name, reason: String(error) });
    }
  }
  return memories;
}
