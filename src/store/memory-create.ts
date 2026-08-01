// The create_memory operation (v2.md §5): validate input, check the scope's
// projects exist, run the dedupe gate, then write the canonical markdown file.
//
// The gate is the reason this operation can decline to write. `memory-policy.md`
// §11 puts the duplicate policy on the agent — search first, extend a near-match
// rather than sitting beside it — and this is where the store holds it to that:
// same-scope neighbours are scored (similarity.ts) and, when one is close enough,
// returned instead of a new file. `force_create` proceeds, but only with a reason.
//
// Evidence that fails the durability rules is dropped and reported rather than
// failing the write (memory-fields.ts): V2 exists to make agents reach for these
// tools more often, and losing a whole insight over one bad reference teaches the
// opposite.

import { join } from 'node:path';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { serializeFrontmatter } from './frontmatter.js';
import { generateId, memoryFilename } from './id.js';
import { buildProvenance, orderMemoryMetadata } from './memory-fields.js';
import {
  createMemoryInputSchema,
  toMemorySummary,
  validateMemoryFrontmatter,
  type CreateMemoryInput,
  type DroppedEvidence,
  type MemoryCandidate,
  type MemorySummary,
} from './memory-schema.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import { assertProjectsRegistered } from './project-registry.js';
import { rebuildIndexUnlocked } from './rebuild.js';
import type { MemoryIndex } from './search-index.js';
import {
  DUPLICATE_CANDIDATE_LIMIT,
  MEMORY_DUPLICATE_THRESHOLD,
  memorySimilarity,
} from './similarity.js';
import { isoSeconds } from './time.js';

export interface CreateMemoryOptions {
  memoriesDir: string;
  projectsDir: string;
  // Required, unlike V1's optional index: the dedupe gate reads its candidate
  // pool from it, so a create without an index would silently skip the gate.
  index: MemoryIndex;
  // Injectable for deterministic tests; default to wall-clock / random ULID.
  now?: number;
  makeId?: (now: number) => string;
}

export class MemoryCreatedIndexError extends Error {
  readonly memoryId: string;
  readonly memoryPath: string;

  constructor(memoryId: string, memoryPath: string, cause: unknown) {
    super(
      `Memory ${memoryId} was written, but the derived index could not be repaired. ` +
        'Verify the durable file and reconcile before retrying.',
      { cause },
    );
    this.name = 'MemoryCreatedIndexError';
    this.memoryId = memoryId;
    this.memoryPath = memoryPath;
  }
}

export type CreateMemoryResult =
  | {
      outcome: 'created';
      id: string;
      path: string;
      memory: MemorySummary;
      dropped_evidence: DroppedEvidence[];
    }
  | { outcome: 'duplicate_candidates'; candidates: MemoryCandidate[] };

export async function createMemory(
  rawInput: unknown,
  options: CreateMemoryOptions,
): Promise<CreateMemoryResult> {
  const input = validate(createMemoryInputSchema, rawInput);

  if (input.scope.kind === 'projects') {
    await assertProjectsRegistered(options.projectsDir, input.scope.project_ids);
  }

  return withMemoryMutationLock(options.memoriesDir, () => createMemoryLocked(input, options));
}

async function createMemoryLocked(
  input: CreateMemoryInput,
  options: CreateMemoryOptions,
): Promise<CreateMemoryResult> {
  if (input.force_create !== true) {
    const candidates = duplicateCandidates(options.index, input);
    if (candidates.length > 0) {
      return { outcome: 'duplicate_candidates', candidates };
    }
  }

  const now = options.now ?? Date.now();
  const id = (options.makeId ?? generateId)(now);
  const timestamp = isoSeconds(now);
  const { provenance, dropped } = buildProvenance(input.provenance);

  // Defense in depth: the record we are about to persist must itself validate.
  const record = validateMemoryFrontmatter({
    id,
    title: input.title,
    description: input.description,
    scope: input.scope,
    type: input.type,
    provenance,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
  });

  const path = join(options.memoriesDir, memoryFilename(id, record.title));
  await atomicWrite(path, serializeFrontmatter(orderMemoryMetadata(record), input.body));

  // Index after the canonical write succeeds. The file is already durable, so it
  // is never lost even if indexing fails; the index is rebuildable.
  try {
    options.index.upsert(record, input.body);
  } catch (initialError) {
    try {
      const rebuilt = await rebuildIndexUnlocked(options.index, options.memoriesDir);
      const skipped = rebuilt.skipped.find(
        (entry) => entry.file === memoryFilename(id, record.title),
      );
      if (skipped !== undefined) throw new Error(skipped.reason);
    } catch (rebuildError) {
      throw new MemoryCreatedIndexError(id, path, { initialError, rebuildError });
    }
  }

  return {
    outcome: 'created',
    id,
    path,
    memory: toMemorySummary(record),
    dropped_evidence: dropped,
  };
}

/**
 * Same-scope memories close enough to the draft to be worth showing instead of
 * writing, best match first.
 *
 * The body is deliberately not compared. Two write-ups of one insight can share
 * little wording while saying the same thing, and two genuinely different
 * memories about one subsystem share a lot — the title and description are the
 * fields written to be distinguishing.
 */
function duplicateCandidates(index: MemoryIndex, input: CreateMemoryInput): MemoryCandidate[] {
  const pool = index.candidates({
    title: input.title,
    description: input.description,
    scope: input.scope,
  });

  return pool
    .map((candidate) => ({ candidate, similarity: memorySimilarity(input, candidate) }))
    .filter((scored) => scored.similarity >= MEMORY_DUPLICATE_THRESHOLD)
    .sort(
      (a, b) =>
        b.similarity - a.similarity || b.candidate.updated_at.localeCompare(a.candidate.updated_at),
    )
    .slice(0, DUPLICATE_CANDIDATE_LIMIT)
    .map((scored) => ({
      id: scored.candidate.id,
      title: scored.candidate.title,
      description: scored.candidate.description,
      scope: scored.candidate.scope,
      type: scored.candidate.type,
      status: scored.candidate.status,
      updated_at: scored.candidate.updated_at,
      // Rounded for reporting only; the gate compares the raw score.
      similarity: Math.round(scored.similarity * 100) / 100,
    }));
}
