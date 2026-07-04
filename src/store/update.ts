// The update_memory operation (§9.2): edit an existing memory in place, modeled
// on a coding agent's file-edit tool. Apply metadata `changes` and/or a body
// edit, re-validate, then rewrite the single canonical file atomically.
//
// There is no version history (§12). The exact-match `old_text` requirement is
// the anti-clobber guard in place of version-based optimistic concurrency: a
// stale edit fails rather than overwriting unexpected content.

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoError } from '../errors.js';
import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { memoryFilename } from './id.js';
import { resolveMemoryPath } from './resolve.js';
import { updateMemoryInputSchema, validateFrontmatter, type UpdateMemoryInput } from './schema.js';
import { isoSeconds } from './time.js';

export interface UpdateMemoryOptions {
  memoriesDir: string;
  // Injectable for deterministic tests; default to wall-clock.
  now?: number;
}

export interface UpdateMemoryResult {
  id: string;
  path: string;
  updated: true;
}

export async function updateMemory(
  rawInput: unknown,
  options: UpdateMemoryOptions,
): Promise<UpdateMemoryResult> {
  const input = validate(updateMemoryInputSchema, rawInput);

  const currentPath = await resolveMemoryPath(options.memoriesDir, input.id);
  const raw = await readFile(currentPath, 'utf8');
  const { metadata, body } = parseFrontmatter(raw);
  // The current file must itself be valid before we build on it.
  validateFrontmatter(metadata);

  const newBody = applyBodyEdit(body, input);

  // Preserve on-disk field order (zod parse would reorder); `id`/`created_at`
  // stay put because `changes` is a strict object that cannot carry them.
  const updated: Record<string, unknown> = { ...metadata };
  if (input.changes) Object.assign(updated, input.changes);
  updated.updated_at = isoSeconds(options.now ?? Date.now());

  // Validate the result for correctness; serialize the ordered object above.
  const validated = validateFrontmatter(updated);

  const targetPath = join(options.memoriesDir, memoryFilename(validated.id, validated.title));
  await atomicWrite(targetPath, serializeFrontmatter(updated, newBody));
  // A title change moves the file; drop the stale name so no duplicate lingers.
  if (targetPath !== currentPath) {
    await unlink(currentPath);
  }

  return { id: validated.id, path: targetPath, updated: true };
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
