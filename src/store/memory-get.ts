// The get_memory operation (v2.md §5): return one memory in full — front matter,
// body, and the names its project ids stand for.
//
// This is the second half of the lightweight-search contract: `search_memories`
// returns summaries so an agent can choose, and this is the only way to the body
// and the provenance. Front matter is validated on the way out as well as in, so a
// hand-edited invalid file surfaces a validation_error rather than a partial read.
//
// Project names are resolved here rather than left to the caller. A memory's front
// matter holds opaque `prj_` ids, so without this an agent reading a memory sees a
// scope it cannot interpret.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { orderMemoryMetadata } from './memory-fields.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import { resolveMemoryPath } from './memory-path.js';
import {
  getMemoryInputSchema,
  memoryProjectIds,
  validateMemoryFrontmatter,
  type MemoryDetail,
  type MemoryProjectRef,
  type MemoryRecord,
} from './memory-schema.js';
import { loadProjectRegistry } from './project-registry.js';
import { rebuildIndexUnlocked } from './rebuild.js';
import type { MemoryIndex } from './search-index.js';
import { isoSeconds } from './time.js';

export interface ReadMemoryOptions {
  memoriesDir: string;
  projectsDir: string;
}

export interface GetMemoryOptions extends ReadMemoryOptions {
  index: MemoryIndex;
  now?: number;
}

/** Explicit access, serialized with decay and edits so a read cannot be lost. */
export async function getMemory(
  rawInput: unknown,
  options: GetMemoryOptions,
): Promise<MemoryDetail> {
  const input = validate(getMemoryInputSchema, rawInput);
  return withMemoryMutationLock(options.memoriesDir, async () => {
    const { path, record, body, projects } = await loadMemory(input.id, options);
    const timestamp = isoSeconds(options.now ?? Date.now());
    record.last_accessed_at = timestamp;
    if (record.status === 'archived' && record.archive_source === 'decay') {
      record.status = 'active';
      record.updated_at = timestamp;
      delete record.archive_reason;
      delete record.archive_source;
      delete record.archived_at;
    } else if (record.status === 'archived' && record.archived_at === undefined) {
      // Legacy manual archives acquire a full deletion grace period on first access.
      record.archived_at = timestamp;
    }
    await atomicWrite(path, serializeFrontmatter(orderMemoryMetadata(record), body));
    try {
      options.index.upsert(record, body);
    } catch (error) {
      const rebuilt = await rebuildIndexUnlocked(options.index, options.memoriesDir);
      if (rebuilt.skipped.some((entry) => entry.file === basename(path))) throw error;
    }
    return { ...record, body, projects };
  });
}

/** Internal inspection must not keep a memory alive or change review snapshots. */
export async function readMemory(
  rawInput: unknown,
  options: ReadMemoryOptions,
): Promise<MemoryDetail> {
  const input = validate(getMemoryInputSchema, rawInput);
  const { record, body, projects } = await loadMemory(input.id, options);
  return { ...record, body, projects };
}

async function loadMemory(id: string, options: ReadMemoryOptions) {
  const path = await resolveMemoryPath(options.memoriesDir, id);
  const { metadata, body } = parseFrontmatter(await readFile(path, 'utf8'));
  const record = validateMemoryFrontmatter(metadata);
  const projects = await resolveProjectNames(options.projectsDir, record);
  return { path, record, body, projects };
}

/**
 * Pair each of a memory's project ids with the name it resolves to, or `null`
 * when the registry holds no such project.
 *
 * A dangling id is reported rather than thrown on: the project record may have
 * been deleted by hand, and that must cost the memory its label, not its
 * readability.
 */
async function resolveProjectNames(
  projectsDir: string,
  record: MemoryRecord,
): Promise<MemoryProjectRef[]> {
  const ids = memoryProjectIds(record);
  if (ids.length === 0) return [];

  const registry = await loadProjectRegistry(projectsDir);
  return ids.map((id) => ({ id, name: registry.byId(id)?.record.name ?? null }));
}
