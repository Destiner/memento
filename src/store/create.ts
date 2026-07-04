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

export interface CreateMemoryOptions {
  memoriesDir: string;
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
  validateFrontmatter(metadata);

  const path = join(options.memoriesDir, memoryFilename(id, input.title));
  await atomicWrite(path, serializeFrontmatter(metadata, input.body));

  return { id, path, created: true };
}

// Second-precision ISO timestamp, matching the §7 format (no milliseconds).
function isoSeconds(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
