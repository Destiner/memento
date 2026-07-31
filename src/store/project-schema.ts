// The canonical project record and its tool-input projections (V2 §2).
//
// A project is the stable identity that memories are scoped to. Paths, git
// remotes, and repository slugs are *identifiers* — evidence that points at a
// project — never primary keys: a checkout moves, a directory later gains a
// remote, a repository gets renamed, and through all of it the `id` must not
// change. Only `id` is the key.
//
// As with memories, this module is the single source of truth for the shape,
// validated both on write and on read-back, so a hand-edited registry file
// surfaces a validation_error rather than poisoning project resolution.

import { z } from 'zod';

import { validate } from '../validation.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const MAX_REASON_LENGTH = 280;

const nonEmpty = z.string().trim().min(1);
const nameSchema = nonEmpty.max(MAX_NAME_LENGTH);
const descriptionSchema = nonEmpty.max(MAX_DESCRIPTION_LENGTH);
const reasonSchema = nonEmpty.max(MAX_REASON_LENGTH);

// Nested rather than flat so a future identifier kind (a package name, an issue
// tracker key) is an additive field here instead of more top-level sprawl.
const identifiersSchema = z
  .object({
    git_remotes: z.array(nonEmpty).optional(),
    repository_slugs: z.array(nonEmpty).optional(),
  })
  .strict();

const workingDirectorySchema = z
  .object({
    path: nonEmpty,
    last_seen_at: z.iso.datetime(),
  })
  .strict();

// Full persisted front matter. Lifecycle fields (id, timestamps) and
// `last_seen_at` are server-managed; everything else is agent-supplied.
export const projectFrontmatterSchema = z
  .object({
    id: nonEmpty,
    name: nameSchema,
    description: descriptionSchema,
    aliases: z.array(nameSchema).optional(),
    identifiers: identifiersSchema.optional(),
    working_directories: z.array(workingDirectorySchema).optional(),
    status: projectStatusSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

// `create_project` input. Working directories arrive as bare path strings —
// `last_seen_at` is stamped by the server, so an agent cannot backdate one.
export const createProjectInputShape = {
  name: nameSchema,
  description: descriptionSchema,
  aliases: z.array(nameSchema).optional(),
  identifiers: identifiersSchema.optional(),
  working_directories: z.array(nonEmpty).optional(),
  // The near-duplicate gate's escape hatch, mirroring `create_memory`. It clears
  // the *similarity* gate only: an exact name or working-directory collision stays
  // an error, because that is a split identity rather than a judgement call.
  force_create: z.boolean().optional(),
  force_create_reason: reasonSchema.optional(),
} as const;

export const createProjectInputSchema = z
  .object(createProjectInputShape)
  .strict()
  .superRefine((input, ctx) => {
    if (input.force_create === true && input.force_create_reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'force_create requires force_create_reason: say why this is a distinct project ' +
          'rather than one of the candidates.',
        path: ['force_create_reason'],
      });
    }
    if (input.force_create_reason !== undefined && input.force_create !== true) {
      ctx.addIssue({
        code: 'custom',
        message: 'force_create_reason has no effect without force_create: true.',
        path: ['force_create'],
      });
    }
  });

// `update_project` input. Array fields merge-append with dedupe by default;
// `replace: true` overwrites only the arrays actually supplied. The default is
// append because the common call is "this checkout moved" or "this repo now has
// a remote" — a one-field patch that must not silently drop the other
// identifiers the project was resolvable by.
export const updateProjectInputShape = {
  id: nonEmpty,
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  aliases: z.array(nameSchema).optional(),
  identifiers: identifiersSchema.optional(),
  working_directories: z.array(nonEmpty).optional(),
  status: projectStatusSchema.optional(),
  replace: z.boolean().optional(),
} as const;

const MUTABLE_UPDATE_FIELDS = [
  'name',
  'description',
  'aliases',
  'identifiers',
  'working_directories',
  'status',
] as const;

export const updateProjectInputSchema = z
  .object(updateProjectInputShape)
  .strict()
  .superRefine((input, ctx) => {
    const touched = MUTABLE_UPDATE_FIELDS.some((field) => input[field] !== undefined);
    if (!touched) {
      ctx.addIssue({
        code: 'custom',
        message: `Provide at least one field to change: ${MUTABLE_UPDATE_FIELDS.join(', ')}.`,
        path: [],
      });
    }
    if (input.replace !== undefined && !touched) {
      ctx.addIssue({
        code: 'custom',
        message: 'replace has no effect without an array field to replace.',
        path: ['replace'],
      });
    }
  });

// `resolve_project` input: whatever evidence the caller happens to have. Every
// field is optional, but at least one must be present — resolution with no
// evidence is a listing, not a resolution.
export const resolveProjectInputShape = {
  working_directory: nonEmpty.optional(),
  git_remote: nonEmpty.optional(),
  repository_slug: nonEmpty.optional(),
  name_hint: nonEmpty.optional(),
  include_archived: z.boolean().optional(),
} as const;

const EVIDENCE_FIELDS = [
  'working_directory',
  'git_remote',
  'repository_slug',
  'name_hint',
] as const;

export const resolveProjectInputSchema = z
  .object(resolveProjectInputShape)
  .strict()
  .superRefine((input, ctx) => {
    if (!EVIDENCE_FIELDS.some((field) => input[field] !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: `Provide at least one piece of evidence: ${EVIDENCE_FIELDS.join(', ')}.`,
        path: [],
      });
    }
  });

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type ProjectRecord = z.infer<typeof projectFrontmatterSchema>;
export type ProjectWorkingDirectory = z.infer<typeof workingDirectorySchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type ResolveProjectInput = z.infer<typeof resolveProjectInputSchema>;

// The lightweight shape returned by resolution and listings: enough for an agent
// to choose between candidates without reading the registry files.
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
}

/**
 * A project the near-duplicate gate is offering instead of creating, with the
 * score that surfaced it. The number is reported so an agent can tell a
 * restatement from a neighbour, not because it is meaningful in itself.
 */
export interface ProjectCandidate extends ProjectSummary {
  similarity: number;
}

export function toProjectSummary(record: ProjectRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

// Validate a parsed front-matter mapping against the canonical project schema.
export function validateProjectFrontmatter(metadata: unknown): ProjectRecord {
  return validate(projectFrontmatterSchema, metadata);
}
