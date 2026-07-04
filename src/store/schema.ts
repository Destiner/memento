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
    version: z.int().positive(),
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
