// The update_project operation (V2 §2): patch a project's mutable fields in
// place, keeping its `id` — and therefore every memory scoped to it — intact.
//
// This is the operation the identity invariants run through. A directory that
// later gains a git remote (P1), a checkout that moved (P2), and a repository
// that was renamed (P3) are all updates, never new projects. Array fields
// therefore merge-append by default: the common call is a one-field patch, and
// it must not silently drop the other identifiers the project is resolvable by.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { serializeFrontmatter } from './frontmatter.js';
import { projectFilename } from './id.js';
import {
  buildAliases,
  buildIdentifiers,
  mergeStrings,
  mergeWorkingDirectories,
  orderProjectMetadata,
} from './project-fields.js';
import { nameKey } from './project-normalize.js';
import { assertNoConflicts, loadProjectRegistry, requireProject } from './project-registry.js';
import {
  updateProjectInputSchema,
  validateProjectFrontmatter,
  type ProjectRecord,
  type UpdateProjectInput,
} from './project-schema.js';
import { isoSeconds } from './time.js';

export interface UpdateProjectOptions {
  projectsDir: string;
  // Injectable for deterministic tests; default to wall-clock.
  now?: number;
}

export interface UpdateProjectResult {
  id: string;
  path: string;
  updated: true;
  record: ProjectRecord;
}

export async function updateProject(
  rawInput: unknown,
  options: UpdateProjectOptions,
): Promise<UpdateProjectResult> {
  const input = validate(updateProjectInputSchema, rawInput);

  const registry = await loadProjectRegistry(options.projectsDir);
  const entry = requireProject(registry, input.id);
  const timestamp = isoSeconds(options.now ?? Date.now());

  const draft = await applyPatch(entry.record, input, timestamp);
  const record = validateProjectFrontmatter(draft);

  // Archived projects are outside the uniqueness namespace (H5), so only an
  // active result is checked — which also re-checks a restore from archived.
  if (record.status === 'active') {
    assertNoConflicts(registry, record);
  }

  const targetPath = join(options.projectsDir, projectFilename(record.id, record.name));
  await atomicWrite(targetPath, serializeFrontmatter(orderProjectMetadata(record), entry.body));
  // A rename moves the file; drop the stale name so no duplicate id lingers.
  if (targetPath !== entry.path) {
    await unlink(entry.path);
  }

  return { id: record.id, path: targetPath, updated: true, record };
}

async function applyPatch(
  current: ProjectRecord,
  input: UpdateProjectInput,
  timestamp: string,
): Promise<Record<string, unknown>> {
  const replace = input.replace ?? false;
  const name = input.name ?? current.name;
  const renamedFrom = nameKey(name) === nameKey(current.name) ? undefined : current.name;

  // P3: a rename preserves the old name as an alias automatically, so an agent
  // cannot break resolution-by-old-name by forgetting to. It survives
  // `replace: true` for the same reason — replace governs the aliases the caller
  // is restating, not the invariant.
  const aliasPool = mergeStrings(current.aliases, input.aliases, replace);
  if (renamedFrom) aliasPool.push(renamedFrom);

  const identifiers = nextIdentifiers(current, input, replace);

  return {
    id: current.id,
    name,
    description: input.description ?? current.description,
    aliases: buildAliases(name, aliasPool),
    identifiers: buildIdentifiers(identifiers.remotes, identifiers.slugs),
    working_directories: await mergeWorkingDirectories(
      current.working_directories ?? [],
      input.working_directories,
      timestamp,
      replace,
    ),
    status: input.status ?? current.status,
    created_at: current.created_at,
    updated_at: timestamp,
  };
}

/**
 * Resolve the remote/slug inputs for the next record.
 *
 * With `replace: true`, the supplied `identifiers` object replaces the stored
 * one wholesale rather than field by field. Otherwise replacing `git_remotes`
 * would leave behind the `repository_slugs` derived from the remotes just
 * removed — stale identifiers that go on producing candidate matches for a
 * repository the project no longer has.
 */
function nextIdentifiers(
  current: ProjectRecord,
  input: UpdateProjectInput,
  replace: boolean,
): { remotes: string[]; slugs: string[] } {
  const incoming = input.identifiers;
  if (incoming === undefined) {
    return {
      remotes: [...(current.identifiers?.git_remotes ?? [])],
      slugs: [...(current.identifiers?.repository_slugs ?? [])],
    };
  }
  if (replace) {
    return {
      remotes: [...(incoming.git_remotes ?? [])],
      slugs: [...(incoming.repository_slugs ?? [])],
    };
  }
  return {
    remotes: mergeStrings(current.identifiers?.git_remotes, incoming.git_remotes, false),
    slugs: mergeStrings(current.identifiers?.repository_slugs, incoming.repository_slugs, false),
  };
}
