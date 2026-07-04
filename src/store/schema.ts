// Controlled vocabularies and the canonical memory metadata schema (§7).
//
// This is the single source of truth for the front-matter shape. The persisted
// record schema is validated both when writing (via create_memory input, which
// derives from these enums) and when reading a file back off disk, so a
// hand-edited or corrupted memory surfaces a validation_error rather than
// propagating bad data into the index.

import { z } from 'zod';

import { validate } from '../validation.js';

export const MEMORY_TYPES = [
  'decision',
  'relationship',
  'product_context',
  'integration',
  'plan',
  'testing',
  'triage',
  'incident_learning',
  'pattern',
  'preference',
  'working_agreement',
] as const;

export const MEMORY_SCOPES = [
  'personal',
  'project',
  'cross_project',
  'external_tooling',
  'product',
  'workflow',
] as const;

export const MEMORY_STATUSES = ['active', 'needs_review', 'superseded', 'archived'] as const;

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export const IMPORTANCE_LEVELS = ['high', 'medium', 'low'] as const;

export const typeSchema = z.enum(MEMORY_TYPES);
export const scopeSchema = z.enum(MEMORY_SCOPES);
export const statusSchema = z.enum(MEMORY_STATUSES);
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export const importanceSchema = z.enum(IMPORTANCE_LEVELS);

// YYYY-MM-DD, used by review_after (a prompt to revalidate, not an expiry).
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

const nonEmpty = z.string().trim().min(1);

// Full persisted front matter. Required lifecycle fields are server-managed;
// the rest are the recommended/optional metadata from §7.
export const frontmatterSchema = z
  .object({
    id: nonEmpty,
    title: nonEmpty,
    type: typeSchema,
    scope: scopeSchema,
    status: statusSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    projects: z.array(nonEmpty).optional(),
    entities: z.array(nonEmpty).optional(),
    tags: z.array(nonEmpty).optional(),
    confidence: confidenceSchema.optional(),
    importance: importanceSchema.optional(),
    review_after: dateOnlySchema.optional(),
    source_kind: nonEmpty.optional(),
    source_refs: z.array(nonEmpty).optional(),
    supersedes: z.array(nonEmpty).optional(),
    related_memories: z.array(nonEmpty).optional(),
  })
  .strict();

// `create_memory` input (§9.1). Server-managed fields (id, status, timestamps)
// are not accepted here. Exposed as a raw shape so the MCP layer can
// advertise and pre-validate it; the derived object schema drives our own
// validate() so createMemory is correct when called directly.
export const createMemoryInputShape = {
  title: nonEmpty,
  type: typeSchema,
  scope: scopeSchema,
  body: nonEmpty,
  projects: z.array(nonEmpty).optional(),
  entities: z.array(nonEmpty).optional(),
  tags: z.array(nonEmpty).optional(),
  confidence: confidenceSchema.optional(),
  importance: importanceSchema.optional(),
  review_after: dateOnlySchema.optional(),
  source_kind: nonEmpty.optional(),
  source_refs: z.array(nonEmpty).optional(),
} as const;

export const createMemoryInputSchema = z.object(createMemoryInputShape).strict();

export type CreateMemoryInput = z.infer<typeof createMemoryInputSchema>;

// `read_memory` input (§9.4): a memory is read by its stable id alone.
export const readMemoryInputShape = {
  id: nonEmpty,
} as const;

export const readMemoryInputSchema = z.object(readMemoryInputShape).strict();

export type ReadMemoryInput = z.infer<typeof readMemoryInputSchema>;

// Editable metadata fields for `update_memory` (§9.2). Everything a user can
// meaningfully change; system fields (id, created_at, updated_at) are omitted
// and, being a strict object, rejected if supplied.
export const updateMemoryChangesShape = {
  title: nonEmpty.optional(),
  type: typeSchema.optional(),
  scope: scopeSchema.optional(),
  status: statusSchema.optional(),
  projects: z.array(nonEmpty).optional(),
  entities: z.array(nonEmpty).optional(),
  tags: z.array(nonEmpty).optional(),
  confidence: confidenceSchema.optional(),
  importance: importanceSchema.optional(),
  review_after: dateOnlySchema.optional(),
  source_kind: nonEmpty.optional(),
  source_refs: z.array(nonEmpty).optional(),
  supersedes: z.array(nonEmpty).optional(),
  related_memories: z.array(nonEmpty).optional(),
} as const;

// `update_memory` input (§9.2). An edit is metadata `changes` and/or a body
// edit — either an exact-match `old_text`/`new_text` replacement or a full
// `body` replacement. Cross-field rules are enforced by the schema below.
export const updateMemoryInputShape = {
  id: nonEmpty,
  changes: z.object(updateMemoryChangesShape).strict().optional(),
  old_text: z.string().optional(),
  new_text: z.string().optional(),
  body: nonEmpty.optional(),
  change_note: nonEmpty.optional(),
} as const;

export const updateMemoryInputSchema = z
  .object(updateMemoryInputShape)
  .strict()
  .superRefine((input, ctx) => {
    const hasChanges = input.changes !== undefined && Object.keys(input.changes).length > 0;
    const hasOldText = input.old_text !== undefined;
    const hasNewText = input.new_text !== undefined;
    const hasBody = input.body !== undefined;

    if (hasOldText !== hasNewText) {
      ctx.addIssue({
        code: 'custom',
        message: 'old_text and new_text must be provided together.',
        path: [hasOldText ? 'new_text' : 'old_text'],
      });
    }
    if (hasBody && hasOldText) {
      ctx.addIssue({
        code: 'custom',
        message: 'body (full replacement) and old_text (surgical edit) are mutually exclusive.',
        path: ['body'],
      });
    }
    if (!hasChanges && !hasOldText && !hasBody) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide at least one of: changes, body, or old_text/new_text.',
        path: [],
      });
    }
  });

export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

// `search_memory` input (§9.3). `query` is the only required field; every filter
// is optional so an agent can ask a plain-language question. `intent` is
// advisory metadata, not a retrieval mode. `limit` is clamped to the configured
// maximum by the operation, so it is only bounded below here.
export const searchMemoryInputShape = {
  query: nonEmpty,
  intent: nonEmpty.optional(),
  project: nonEmpty.optional(),
  types: z.array(typeSchema).optional(),
  scopes: z.array(scopeSchema).optional(),
  entities: z.array(nonEmpty).optional(),
  tags: z.array(nonEmpty).optional(),
  status: z.array(statusSchema).optional(),
  limit: z.number().int().min(1).optional(),
  include_excerpt: z.boolean().optional(),
} as const;

export const searchMemoryInputSchema = z.object(searchMemoryInputShape).strict();

export type SearchMemoryInput = z.infer<typeof searchMemoryInputSchema>;

export type MemoryType = z.infer<typeof typeSchema>;
export type MemoryScope = z.infer<typeof scopeSchema>;
export type MemoryStatus = z.infer<typeof statusSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Importance = z.infer<typeof importanceSchema>;
export type MemoryMetadata = z.infer<typeof frontmatterSchema>;

// Validate a parsed front-matter mapping against the canonical schema,
// throwing a per-field validation_error on any vocabulary or shape violation.
export function validateFrontmatter(metadata: unknown): MemoryMetadata {
  return validate(frontmatterSchema, metadata);
}
