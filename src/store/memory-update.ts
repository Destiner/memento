// The update_memory operation (v2.md §5): edit an existing memory in place,
// modeled on a coding agent's file-edit tool.
//
// This is the operation `memory-policy.md` §11 wants agents to reach for instead
// of writing a second memory, so it has to be able to express every kind of
// correction: retitle, re-scope, re-type, extend the evidence, replace or
// surgically edit the body, restore an archived memory, or simply record that the
// memory was re-checked and still holds.
//
// Two guards it keeps from V1: the exact-match `old_text` requirement, which is
// the anti-clobber check in place of version-based concurrency (there is no
// history), and validating the file *before* building on it, so an edit never
// half-repairs a corrupt record.
//
// Archiving deliberately does not route through here — `archive_memory` requires
// a reason, and accepting `status: 'archived'` in `changes` would be a
// reason-free back door into the one state §10 says must always be explained.

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoError } from '../errors.js';
import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { memoryFilename } from './id.js';
import { mergeProvenance, mergeScope, orderMemoryMetadata } from './memory-fields.js';
import { resolveMemoryPath } from './memory-path.js';
import {
  toMemorySummary,
  updateMemoryInputSchema,
  validateMemoryFrontmatter,
  type DroppedEvidence,
  type MemoryRecord,
  type MemorySummary,
  type UpdateMemoryInput,
} from './memory-schema.js';
import { assertProjectsRegistered } from './project-registry.js';
import { rebuildIndexUnlocked } from './rebuild.js';
import type { MemoryIndex } from './search-index.js';
import { memorySnapshotSha256 } from './memory-snapshot.js';
import { withMemoryMutationLock } from './memory-mutation-lock.js';
import { isoSeconds } from './time.js';

export interface UpdateMemoryOptions {
  memoriesDir: string;
  projectsDir: string;
  index: MemoryIndex;
  // Injectable for deterministic tests; default to wall-clock.
  now?: number;
  // Internal compare-and-swap guard used by reviewed retrospective updates.
  expectedCurrentSha256?: string;
}

export interface UpdateMemoryResult {
  id: string;
  path: string;
  updated: true;
  memory: MemorySummary;
  dropped_evidence: DroppedEvidence[];
}

export class MemoryUpdatedPersistenceError extends Error {
  readonly memoryId: string;
  readonly memoryPath: string;

  constructor(memoryId: string, memoryPath: string, cause: unknown) {
    super(
      `Memory ${memoryId} was written, but post-write cleanup or index repair failed. ` +
        'Verify the durable files and reconcile before retrying.',
      { cause },
    );
    this.name = 'MemoryUpdatedPersistenceError';
    this.memoryId = memoryId;
    this.memoryPath = memoryPath;
  }
}

export class MemoryUpdateConflictError extends MementoError {
  constructor(id: string) {
    super(
      'invalid_request',
      'Memory changed after review; review the current record before updating it.',
      {
        id,
      },
    );
    this.name = 'MemoryUpdateConflictError';
  }
}

export async function updateMemory(
  rawInput: unknown,
  options: UpdateMemoryOptions,
): Promise<UpdateMemoryResult> {
  const input = validate(updateMemoryInputSchema, rawInput);

  // Only the ids the caller supplied are checked. The ones already on the record
  // are not: a hand-deleted project must not block an unrelated edit to every
  // memory that referenced it.
  const incomingScope = input.changes?.scope;
  if (incomingScope?.kind === 'projects') {
    await assertProjectsRegistered(options.projectsDir, incomingScope.project_ids);
  }

  return withMemoryMutationLock(options.memoriesDir, () => updateMemoryLocked(input, options));
}

async function updateMemoryLocked(
  input: UpdateMemoryInput,
  options: UpdateMemoryOptions,
): Promise<UpdateMemoryResult> {
  const currentPath = await resolveMemoryPath(options.memoriesDir, input.id);
  const { metadata, body } = parseFrontmatter(await readFile(currentPath, 'utf8'));
  // The current file must itself be valid before we build on it.
  const current = validateMemoryFrontmatter(metadata);
  if (
    options.expectedCurrentSha256 !== undefined &&
    memorySnapshotSha256(current, body) !== options.expectedCurrentSha256
  ) {
    throw new MemoryUpdateConflictError(input.id);
  }

  const newBody = applyBodyEdit(body, input);
  const timestamp = isoSeconds(options.now ?? Date.now());
  const { draft, dropped } = applyChanges(current, input, timestamp);
  const record = validateMemoryFrontmatter(draft);

  const targetPath = join(options.memoriesDir, memoryFilename(record.id, record.title));
  await atomicWrite(targetPath, serializeFrontmatter(orderMemoryMetadata(record), newBody));
  try {
    // A title change moves the file; drop the stale name so no duplicate lingers.
    if (targetPath !== currentPath) {
      await unlink(currentPath);
    }

    // Re-index the edited record (upsert is keyed on id, so it replaces in place).
    try {
      options.index.upsert(record, newBody);
    } catch (initialError) {
      try {
        const rebuilt = await rebuildIndexUnlocked(options.index, options.memoriesDir);
        const skipped = rebuilt.skipped.find(
          (entry) => entry.file === memoryFilename(record.id, record.title),
        );
        if (skipped !== undefined) throw new Error(skipped.reason);
      } catch (rebuildError) {
        throw new MemoryUpdatedPersistenceError(record.id, targetPath, {
          initialError,
          rebuildError,
        });
      }
    }
  } catch (error) {
    if (error instanceof MemoryUpdatedPersistenceError) throw error;
    throw new MemoryUpdatedPersistenceError(record.id, targetPath, error);
  }

  return {
    id: record.id,
    path: targetPath,
    updated: true,
    memory: toMemorySummary(record),
    dropped_evidence: dropped,
  };
}

/**
 * Fold the patch into the current record.
 *
 * `id` and `created_at` are carried through untouched — `changes` is a strict
 * object that cannot name them. `last_verified_at` is server-stamped from
 * `mark_verified` so an agent cannot backdate a verification, the same rule
 * `last_seen_at` follows on the project side.
 */
function applyChanges(
  current: MemoryRecord,
  input: UpdateMemoryInput,
  timestamp: string,
): { draft: Record<string, unknown>; dropped: DroppedEvidence[] } {
  const changes = input.changes ?? {};
  const replace = input.replace ?? false;
  const status = changes.status ?? current.status;
  const { provenance, dropped } = mergeProvenance(current.provenance, changes.provenance, replace);

  const draft: Record<string, unknown> = {
    id: current.id,
    title: changes.title ?? current.title,
    description: changes.description ?? current.description,
    scope: mergeScope(current.scope, changes.scope, replace),
    type: changes.type ?? current.type,
    provenance,
    status,
    created_at: current.created_at,
    updated_at: timestamp,
  };

  const verifiedAt = input.mark_verified === true ? timestamp : current.last_verified_at;
  if (verifiedAt !== undefined) draft.last_verified_at = verifiedAt;
  // A restore to `active` drops the reason it was archived for; the schema rejects
  // an active memory that still carries one.
  if (status === 'archived' && current.archive_reason !== undefined) {
    draft.archive_reason = current.archive_reason;
  }

  return { draft, dropped };
}

// Produce the new body: a full replacement, an exact-match surgical edit, or the
// unchanged body when the update only touches metadata.
function applyBodyEdit(body: string, input: UpdateMemoryInput): string {
  if (input.body !== undefined) {
    return input.body;
  }
  if (input.old_text === undefined) {
    return body;
  }

  const oldText = input.old_text;
  const first = body.indexOf(oldText);
  if (first === -1) {
    throw new MementoError('invalid_request', 'old_text was not found in the memory body.');
  }
  if (body.indexOf(oldText, first + 1) !== -1) {
    throw new MementoError(
      'invalid_request',
      'old_text matched the memory body more than once; make it unique.',
    );
  }
  return body.slice(0, first) + (input.new_text ?? '') + body.slice(first + oldText.length);
}
