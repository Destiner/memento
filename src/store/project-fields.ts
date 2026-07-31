// Field assembly shared by project create and update: turning the loose
// identifier evidence an agent supplies into the canonical, deduplicated arrays
// the record stores.
//
// Every function here is idempotent, because update feeds a record's existing
// (already canonical) values back through the same path when merging.

import {
  dedupeBy,
  deriveRepositorySlug,
  MAX_WORKING_DIRECTORIES,
  nameKey,
  normalizeGitRemote,
  normalizeRepositorySlug,
  normalizeWorkingDirectory,
  workingDirectoryKey,
} from './project-normalize.js';
import type { ProjectRecord, ProjectWorkingDirectory } from './project-schema.js';

export interface ProjectIdentifiers {
  git_remotes?: string[];
  repository_slugs?: string[];
}

/**
 * Canonicalize remotes and slugs into the stored `identifiers` object.
 *
 * A slug is derived from every remote and unioned with the explicitly supplied
 * ones, so an agent that knows only the clone URL still gets slug-based
 * resolution. Empty arrays are omitted so the persisted YAML stays clean.
 */
export function buildIdentifiers(
  remotes: readonly string[] = [],
  slugs: readonly string[] = [],
): ProjectIdentifiers | undefined {
  const canonicalRemotes = dedupeBy(remotes.map(normalizeGitRemote), (remote) => remote);
  const derived = canonicalRemotes
    .map(deriveRepositorySlug)
    .filter((slug): slug is string => slug !== undefined);
  const canonicalSlugs = dedupeBy(
    [...slugs.map(normalizeRepositorySlug), ...derived],
    (slug) => slug,
  );

  const identifiers: ProjectIdentifiers = {};
  if (canonicalRemotes.length > 0) identifiers.git_remotes = canonicalRemotes;
  if (canonicalSlugs.length > 0) identifiers.repository_slugs = canonicalSlugs;
  return Object.keys(identifiers).length > 0 ? identifiers : undefined;
}

/**
 * Fold newly-seen checkout paths into a project's existing ones.
 *
 * A path already on record has its `last_seen_at` refreshed rather than being
 * duplicated; a genuinely new one is appended, because a second entry is as
 * likely to be a worktree or another machine as a move (P2). The array is kept
 * sorted most-recently-seen first, which makes eviction past the cap a slice and
 * makes the file readable at a glance.
 */
export async function mergeWorkingDirectories(
  existing: readonly ProjectWorkingDirectory[],
  incomingPaths: readonly string[] | undefined,
  timestamp: string,
  replace = false,
): Promise<ProjectWorkingDirectory[] | undefined> {
  if (incomingPaths === undefined) {
    return existing.length > 0 ? [...existing] : undefined;
  }

  const incoming: ProjectWorkingDirectory[] = [];
  for (const path of incomingPaths) {
    incoming.push({ path: await normalizeWorkingDirectory(path), last_seen_at: timestamp });
  }

  const combined = replace ? incoming : [...incoming, ...existing];
  const deduped = dedupeBy(combined, (entry) => workingDirectoryKey(entry.path));
  // Stable sort: entries stamped in this call share `timestamp` and keep their
  // supplied order ahead of equally-recent existing ones.
  const ordered = deduped.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  const capped = ordered.slice(0, MAX_WORKING_DIRECTORIES);
  return capped.length > 0 ? capped : undefined;
}

/**
 * Deduplicate aliases and drop any that collide with the project's own name —
 * an alias for the current name is noise, and would self-trip the H3 uniqueness
 * check.
 */
export function buildAliases(name: string, aliases: readonly string[] = []): string[] | undefined {
  const key = nameKey(name);
  const cleaned = dedupeBy(
    aliases.filter((alias) => nameKey(alias) !== key),
    nameKey,
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Serialize a record's fields in canonical order, omitting empty optionals.
 *
 * Update rebuilds this order rather than preserving whatever order it found on
 * disk (which is what `update_memory` does). A memory carries prose and a dozen
 * optional fields a person may have arranged deliberately; a project record is
 * nine structured fields, where a predictable layout is worth more than a
 * preserved shuffle.
 */
export function orderProjectMetadata(record: ProjectRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    id: record.id,
    name: record.name,
    description: record.description,
  };
  if (record.aliases?.length) metadata.aliases = record.aliases;
  if (record.identifiers && Object.keys(record.identifiers).length > 0) {
    metadata.identifiers = record.identifiers;
  }
  if (record.working_directories?.length) {
    metadata.working_directories = record.working_directories;
  }
  metadata.status = record.status;
  metadata.created_at = record.created_at;
  metadata.updated_at = record.updated_at;
  return metadata;
}

/** Merge two optional string arrays, or take the incoming one when replacing. */
export function mergeStrings(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
  replace: boolean,
): string[] {
  if (incoming === undefined) return [...(existing ?? [])];
  return replace ? [...incoming] : [...(existing ?? []), ...incoming];
}
