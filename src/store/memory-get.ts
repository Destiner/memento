// The get_memory operation (v2.md §5): return one memory in full — front matter,
// body, and the names its project ids stand for.
//
// This is the second half of the lightweight-search contract: `search_memories`
// returns summaries so an agent can choose, and this is the only way to the body
// and the provenance. Front matter is validated on the way out as well as in, so a
// hand-edited or V1 file surfaces a validation_error rather than a partial read.
//
// Project names are resolved here rather than left to the caller. A memory's front
// matter holds opaque `prj_` ids, so without this an agent reading a memory sees a
// scope it cannot interpret.

import { readFile } from 'node:fs/promises';

import { validate } from '../validation.js';
import { parseFrontmatter } from './frontmatter.js';
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

export interface GetMemoryOptions {
  memoriesDir: string;
  projectsDir: string;
}

export async function getMemory(
  rawInput: unknown,
  options: GetMemoryOptions,
): Promise<MemoryDetail> {
  const input = validate(getMemoryInputSchema, rawInput);

  const path = await resolveMemoryPath(options.memoriesDir, input.id);
  const { metadata, body } = parseFrontmatter(await readFile(path, 'utf8'));
  const record = validateMemoryFrontmatter(metadata);

  return { ...record, body, projects: await resolveProjectNames(options.projectsDir, record) };
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
