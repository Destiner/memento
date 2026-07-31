// The create_project operation (V2 §2): mint a project identity and write its
// canonical registry file.
//
// This is the explicit step after resolution fails. It refuses to register a
// project whose name or checkout path already belongs to an active one (H2, H3),
// so the "agent resolved, missed, and created a duplicate" failure mode surfaces
// as an error naming the existing project rather than as a silently split
// identity that memories then accumulate against on both sides.

import { join } from 'node:path';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { serializeFrontmatter } from './frontmatter.js';
import { generateProjectId, projectFilename } from './id.js';
import {
  buildAliases,
  buildIdentifiers,
  mergeWorkingDirectories,
  orderProjectMetadata,
} from './project-fields.js';
import { assertNoConflicts, loadProjectRegistry } from './project-registry.js';
import {
  createProjectInputSchema,
  validateProjectFrontmatter,
  type CreateProjectInput,
  type ProjectRecord,
} from './project-schema.js';
import { isoSeconds } from './time.js';

export interface CreateProjectOptions {
  projectsDir: string;
  // Injectable for deterministic tests; default to wall-clock / random ULID.
  now?: number;
  makeId?: (now: number) => string;
}

export interface CreateProjectResult {
  id: string;
  path: string;
  created: true;
  record: ProjectRecord;
}

export async function createProject(
  rawInput: unknown,
  options: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const input = validate(createProjectInputSchema, rawInput);

  const now = options.now ?? Date.now();
  const id = (options.makeId ?? generateProjectId)(now);
  const timestamp = isoSeconds(now);

  const draft = await buildRecord(input, id, timestamp);
  // Defense in depth: the record we are about to persist must itself validate.
  const record = validateProjectFrontmatter(draft);

  const registry = await loadProjectRegistry(options.projectsDir);
  assertNoConflicts(registry, record);

  const path = join(options.projectsDir, projectFilename(id, record.name));
  // The body is the owner's notes area, empty until a human writes in it.
  await atomicWrite(path, serializeFrontmatter(orderProjectMetadata(record), ''));

  return { id, path, created: true, record };
}

async function buildRecord(
  input: CreateProjectInput,
  id: string,
  timestamp: string,
): Promise<Record<string, unknown>> {
  return {
    id,
    name: input.name,
    description: input.description,
    aliases: buildAliases(input.name, input.aliases),
    identifiers: buildIdentifiers(
      input.identifiers?.git_remotes,
      input.identifiers?.repository_slugs,
    ),
    working_directories: await mergeWorkingDirectories([], input.working_directories, timestamp),
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
  };
}
