// The create_memory operation (§9.1): validate input, mint identity and
// lifecycle fields, and write the canonical markdown file atomically.
//
// Index update and event logging happen after a successful canonical write
// (§12) and are wired in later phases (search: Phase 3, logging: Phase 5). The
// seams are intentionally left here rather than stubbed, so the write path never
// claims work it has not done.

import { join } from 'node:path';

import { validate } from '../validation.js';
import { atomicWrite } from './atomic.js';
import { serializeFrontmatter } from './frontmatter.js';
import { generateId, memoryFilename } from './id.js';
import { createMemoryInputSchema, validateFrontmatter, type CreateMemoryInput } from './schema.js';
import type { MemoryIndex } from './search-index.js';
import { isoSeconds } from './time.js';

export interface CreateMemoryOptions {
  memoriesDir: string;
  // Derived index to keep in sync after the canonical write (§12). Optional so
  // the store is usable without search wiring (e.g. unit tests).
  index?: MemoryIndex;
  // Injectable for deterministic tests; default to wall-clock / random ULID.
  now?: number;
  makeId?: (now: number) => string;
}

export interface CreateMemoryResult {
  id: string;
  path: string;
  created: true;
}

export async function createMemory(
  rawInput: unknown,
  options: CreateMemoryOptions,
): Promise<CreateMemoryResult> {
  const input = validate(createMemoryInputSchema, rawInput);

  const now = options.now ?? Date.now();
  const id = (options.makeId ?? generateId)(now);
  const timestamp = isoSeconds(now);

  const metadata = buildMetadata(input, id, timestamp);
  // Defense in depth: the record we are about to persist must itself validate.
  const validated = validateFrontmatter(metadata);

  const path = join(options.memoriesDir, memoryFilename(id, input.title));
  await atomicWrite(path, serializeFrontmatter(metadata, input.body));

  // Index after the canonical write succeeds (§12). The file is already durable,
  // so it is never lost even if indexing fails; the index is rebuildable.
  options.index?.upsert(validated, input.body);

  return { id, path, created: true };
}

// Assemble front matter in canonical field order, including optional fields only
// when supplied so the persisted YAML stays clean.
function buildMetadata(
  input: CreateMemoryInput,
  id: string,
  timestamp: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    id,
    title: input.title,
    type: input.type,
    scope: input.scope,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
  };

  if (input.projects) metadata.projects = input.projects;
  if (input.entities) metadata.entities = input.entities;
  if (input.tags) metadata.tags = input.tags;
  if (input.confidence) metadata.confidence = input.confidence;
  if (input.importance) metadata.importance = input.importance;
  if (input.review_after) metadata.review_after = input.review_after;
  if (input.source_kind) metadata.source_kind = input.source_kind;
  if (input.source_refs) metadata.source_refs = input.source_refs;

  return metadata;
}
