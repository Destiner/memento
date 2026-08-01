// The archive_memory operation (v2.md §5): retire a memory without destroying it.
//
// Soft deletion is the only deletion agents get (`docs/memory-policy.md` §10). An
// archived memory keeps its file and its index row, so it stays recoverable, stays
// auditable, and still answers a search that explicitly asks for archived
// material — it simply stops surfacing in the default one.
//
// The reason is required. §10's "archive rather than delete, always with a reason"
// is frozen and canonical, so it wins over v2.md §5's looser wording: a memory
// that stopped being true, with no note saying why, is a worse artifact than no
// memory at all. Restoring is `update_memory` back to `active`, which clears the
// reason.
//
// Archiving twice is not an error. It is a state assertion, and the second call's
// reason is the better-informed one, so it replaces the first.

import { readFile } from 'node:fs/promises';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { orderMemoryMetadata } from './memory-fields.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import { resolveMemoryPath } from './memory-path.js';
import {
  archiveMemoryInputSchema,
  toMemorySummary,
  validateMemoryFrontmatter,
  type MemorySummary,
} from './memory-schema.js';
import type { MemoryIndex } from './search-index.js';
import { isoSeconds } from './time.js';

export interface ArchiveMemoryOptions {
  memoriesDir: string;
  index: MemoryIndex;
  // Injectable for deterministic tests; default to wall-clock.
  now?: number;
}

export interface ArchiveMemoryResult {
  id: string;
  path: string;
  archived: true;
  memory: MemorySummary;
}

export async function archiveMemory(
  rawInput: unknown,
  options: ArchiveMemoryOptions,
): Promise<ArchiveMemoryResult> {
  const input = validate(archiveMemoryInputSchema, rawInput);

  return withMemoryMutationLock(options.memoriesDir, () => archiveMemoryLocked(input, options));
}

async function archiveMemoryLocked(
  input: { id: string; reason: string },
  options: ArchiveMemoryOptions,
): Promise<ArchiveMemoryResult> {
  const path = await resolveMemoryPath(options.memoriesDir, input.id);
  const { metadata, body } = parseFrontmatter(await readFile(path, 'utf8'));
  const current = validateMemoryFrontmatter(metadata);

  const record = validateMemoryFrontmatter({
    ...current,
    status: 'archived',
    archive_reason: input.reason,
    updated_at: isoSeconds(options.now ?? Date.now()),
  });

  // The title is untouched, so the filename is unchanged and no rename is needed.
  await atomicWrite(path, serializeFrontmatter(orderMemoryMetadata(record), body));
  options.index.upsert(record, body);

  return { id: record.id, path, archived: true, memory: toMemorySummary(record) };
}
