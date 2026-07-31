// The create_project operation (V2 §2, §5): mint a project identity and write its
// canonical registry file.
//
// This is the explicit step after resolution fails, and it guards the same
// failure mode twice, because that mode — "the agent resolved, missed, and
// registered a second project for one thing" — is the most expensive mistake in
// the registry: every memory written afterwards accumulates against whichever id
// that session happened to hold.
//
//   - An *exact* collision on a name, an alias, or a checkout path is an error
//     naming the owner (H2, H3). There is no judgement to exercise: those fields
//     are how resolution finds a project, so two projects cannot share them.
//   - A *near* collision returns candidates and writes nothing. This one is a
//     judgement call — `api` and `api-server` are sometimes two projects — so the
//     agent decides, and `force_create` with a reason proceeds.
//
// force_create clears the second gate only. An exact conflict stays an error.

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
import {
  assertNoConflicts,
  loadProjectRegistry,
  type ProjectRegistry,
} from './project-registry.js';
import {
  createProjectInputSchema,
  toProjectSummary,
  validateProjectFrontmatter,
  type CreateProjectInput,
  type ProjectCandidate,
  type ProjectRecord,
} from './project-schema.js';
import {
  DUPLICATE_CANDIDATE_LIMIT,
  PROJECT_DUPLICATE_THRESHOLD,
  projectSimilarity,
} from './similarity.js';
import { isoSeconds } from './time.js';

export interface CreateProjectOptions {
  projectsDir: string;
  // Injectable for deterministic tests; default to wall-clock / random ULID.
  now?: number;
  makeId?: (now: number) => string;
}

export type CreateProjectResult =
  | { outcome: 'created'; id: string; path: string; record: ProjectRecord }
  | { outcome: 'duplicate_candidates'; candidates: ProjectCandidate[] };

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

  if (input.force_create !== true) {
    const candidates = duplicateCandidates(registry, record);
    if (candidates.length > 0) {
      return { outcome: 'duplicate_candidates', candidates };
    }
  }

  const path = join(options.projectsDir, projectFilename(id, record.name));
  // The body is the owner's notes area, empty until a human writes in it.
  await atomicWrite(path, serializeFrontmatter(orderProjectMetadata(record), ''));

  return { outcome: 'created', id, path, record };
}

/**
 * Active projects similar enough to the draft to be worth showing instead of
 * writing, best match first.
 *
 * Archived projects are excluded, matching the uniqueness namespace (H5): one was
 * deliberately retired, and offering it as a candidate would ask the agent to
 * resurrect a project the owner closed.
 */
function duplicateCandidates(registry: ProjectRegistry, draft: ProjectRecord): ProjectCandidate[] {
  return registry.active
    .map((entry) => ({ record: entry.record, similarity: projectSimilarity(draft, entry.record) }))
    .filter((scored) => scored.similarity >= PROJECT_DUPLICATE_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity || a.record.name.localeCompare(b.record.name))
    .slice(0, DUPLICATE_CANDIDATE_LIMIT)
    .map((scored) => ({
      ...toProjectSummary(scored.record),
      // Rounded for reporting only; the gate compares the raw score.
      similarity: Math.round(scored.similarity * 100) / 100,
    }));
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
