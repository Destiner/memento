// The in-memory project registry: load every record off disk, index it by the
// identifiers resolution matches on, and enforce the uniqueness invariants.
//
// There is deliberately no cache. The registry holds tens of records, not
// thousands, so a full directory read costs less than a millisecond — and the
// obvious cache key (directory mtime) is wrong: an in-place edit to one file
// changes the file's mtime, not the directory's, so a human correcting a
// registry entry by hand would be silently ignored. Files stay authoritative
// (AGENTS.md "Patterns"); if this ever profiles hot, cache on the max of every
// file's mtime, not the directory's.
//
// An unparseable registry file is a hard internal_error rather than a skipped
// entry. Dropping a project silently is the worst available outcome: resolution
// then reports not_found, an agent creates a duplicate, and memories accumulate
// against two ids for one project.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoError } from '../errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { assertInsideRoot, assertSafeProjectId } from './path-safety.js';
import {
  dedupeBy,
  nameKey,
  normalizeWorkingDirectory,
  workingDirectoryKey,
} from './project-normalize.js';
import { validateProjectFrontmatter, type ProjectRecord } from './project-schema.js';

export interface ProjectEntry {
  record: ProjectRecord;
  path: string;
  // Free-form human notes. Never parsed; carried so an update rewrites the file
  // without discarding whatever the owner wrote under the front matter.
  body: string;
}

export interface ProjectRegistry {
  all: ProjectEntry[];
  active: ProjectEntry[];
  byId(id: string): ProjectEntry | undefined;
}

/** Read and validate every project record in `projectsDir`. */
export async function loadProjectRegistry(projectsDir: string): Promise<ProjectRegistry> {
  const entries = await readAll(projectsDir);

  const byId = new Map<string, ProjectEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.record.id);
    if (existing) {
      throw new MementoError('internal_error', `Two project files claim id ${entry.record.id}.`, {
        id: entry.record.id,
        paths: [existing.path, entry.path],
      });
    }
    byId.set(entry.record.id, entry);
  }

  return {
    all: entries,
    active: entries.filter((entry) => entry.record.status === 'active'),
    byId: (id) => byId.get(id),
  };
}

/** Look up a project by id, throwing not_found rather than returning undefined. */
export function requireProject(registry: ProjectRegistry, id: string): ProjectEntry {
  assertSafeProjectId(id);
  const entry = registry.byId(id);
  if (!entry) {
    throw new MementoError('not_found', `No project found with id ${id}.`, { id });
  }
  return entry;
}

/**
 * Assert that every supplied project id is registered, naming the ones that are
 * not.
 *
 * This is the check that keeps `scope.project_ids` meaningful: an id an agent
 * invented, or copied from another machine, would otherwise file a memory where
 * no search will ever scope to it. Archived projects pass — a project is retired,
 * its accumulated memories are not.
 *
 * Ids *already stored* on a memory are deliberately not checked (memory-schema.ts
 * header): a hand-deleted project record must not make its memories unreadable.
 * Only what a caller supplies is validated.
 */
export function assertProjectsExist(registry: ProjectRegistry, ids: readonly string[]): void {
  const unknown = ids.filter((id) => registry.byId(id) === undefined);
  if (unknown.length > 0) {
    throw new MementoError(
      'not_found',
      `No project is registered for ${unknown.join(', ')}. Run resolve_project to find the ` +
        'right id, or create_project to register it — never invent one.',
      { unknown_ids: unknown },
    );
  }
}

/** Load the registry and assert every supplied id exists (the common call). */
export async function assertProjectsRegistered(
  projectsDir: string,
  ids: readonly string[],
): Promise<void> {
  assertProjectsExist(await loadProjectRegistry(projectsDir), ids);
}

/**
 * Every name and alias a project answers to, as comparison keys.
 *
 * Names and aliases share one namespace (H3): an alias exists precisely so that
 * resolution can match it, so a new project named after another's former name
 * would make both unresolvable.
 */
export function projectNameKeys(record: ProjectRecord): string[] {
  return dedupeBy([record.name, ...(record.aliases ?? [])].map(nameKey), (key) => key).filter(
    (key) => key !== '',
  );
}

/** Every working-directory path a project claims, as comparison keys. */
export function projectDirectoryKeys(record: ProjectRecord): string[] {
  return (record.working_directories ?? []).map((entry) => workingDirectoryKey(entry.path));
}

export type ConflictField = 'name' | 'working_directory';

export interface ProjectConflict {
  conflict: ConflictField;
  value: string;
  project_id: string;
  project_name: string;
}

/**
 * Assert that `candidate` does not collide with any other *active* project on
 * the hard-unique fields (H2, H3).
 *
 * Archived projects are excluded (H5), so archiving frees a name and a path for
 * reuse. Restoring one therefore has to re-run this check — which it does, since
 * update validates whenever the resulting record is active.
 */
export function assertNoConflicts(registry: ProjectRegistry, candidate: ProjectRecord): void {
  const names = new Set(projectNameKeys(candidate));
  const directories = new Set(projectDirectoryKeys(candidate));

  for (const entry of registry.active) {
    if (entry.record.id === candidate.id) continue;

    for (const key of projectNameKeys(entry.record)) {
      if (names.has(key)) throw conflictError('name', key, entry.record);
    }
    for (const key of projectDirectoryKeys(entry.record)) {
      if (directories.has(key)) throw conflictError('working_directory', key, entry.record);
    }
  }
}

/**
 * Resolve and normalize the working directory a caller supplied, if any. Shared
 * by the write and resolution paths so both sides of a path comparison went
 * through the same canonicalization.
 */
export async function normalizeOptionalDirectory(
  path: string | undefined,
): Promise<string | undefined> {
  return path === undefined ? undefined : await normalizeWorkingDirectory(path);
}

function conflictError(field: ConflictField, value: string, owner: ProjectRecord): MementoError {
  const detail: ProjectConflict = {
    conflict: field,
    value,
    project_id: owner.id,
    project_name: owner.name,
  };
  const subject =
    field === 'name' ? `The name or alias "${value}"` : `The working directory "${value}"`;
  return new MementoError(
    'invalid_request',
    `${subject} already belongs to project ${owner.id} (${owner.name}). ` +
      'Update that project instead of registering a second one for it.',
    detail,
  );
}

async function readAll(projectsDir: string): Promise<ProjectEntry[]> {
  let filenames: string[];
  try {
    filenames = await readdir(projectsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries: ProjectEntry[] = [];
  for (const filename of filenames.filter((name) => name.endsWith('.md')).sort()) {
    const path = join(projectsDir, filename);
    await assertInsideRoot(projectsDir, path);
    entries.push(await readEntry(path));
  }
  return entries;
}

async function readEntry(path: string): Promise<ProjectEntry> {
  const raw = await readFile(path, 'utf8');
  let metadata: Record<string, unknown>;
  let body: string;
  try {
    ({ metadata, body } = parseFrontmatter(raw));
  } catch (error) {
    throw new MementoError(
      'internal_error',
      `Project file ${path} is not a valid record: ${(error as Error).message}`,
      { path },
    );
  }

  let record: ProjectRecord;
  try {
    record = validateProjectFrontmatter(metadata);
  } catch (error) {
    throw new MementoError(
      'internal_error',
      `Project file ${path} failed schema validation. Fix or remove it; project ` +
        'resolution cannot run against a partially readable registry.',
      { path, cause: error instanceof MementoError ? error.toShape() : String(error) },
    );
  }

  assertSafeProjectId(record.id);
  return { record, path, body };
}
