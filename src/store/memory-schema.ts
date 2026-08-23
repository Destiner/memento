// The canonical V2 memory record and its tool-input projections (v2.md §3).
//
// One memory is one markdown file: this front matter plus a prose body. The
// vocabulary — types, scopes, provenance, status — is frozen in
// `docs/memory-policy.md` §7-§10 and mirrored here verbatim. That document is the
// source of truth for *what* the words mean; this module is where they become
// enforceable, and it is the only place the shape is defined.
//
// Validated on write and again on read-back, so a hand-edited file surfaces a
// validation_error rather than propagating bad data into the index. Two rules
// keep that guarantee compatible with a store people are meant to edit
// (AGENTS.md "Patterns"):
//
//   - Project ids are checked for *format* here and for *existence* by the
//     operations, against the registry. A project file deleted by hand must not
//     make every memory that referenced it unreadable; a dangling id degrades to
//     an un-filterable one and surfaces in the report.
//   - Evidence is checked for *shape* here and for *durability* in
//     memory-fields.ts, on the write path only. Same reason: a sloppy
//     hand-written reference costs that entry, never the memory.
//
// Every object is strict, so unknown fields fail validation loudly instead of
// being silently half-read.

import { z } from 'zod';

import { validate } from '../validation.js';
import { MEMORY_ID_PATTERN, PROJECT_ID_PATTERN } from './path-safety.js';

// Exactly one type per memory (§7). `other` is deliberately last and
// deliberately discouraged: a rising `other` rate means the taxonomy needs a new
// type, not that agents are filing correctly.
export const MEMORY_TYPES = [
  'debugging_pattern',
  'cross_project_context',
  'decision_history',
  'product_rationale',
  'preference',
  'environment_workflow_quirk',
  'papercut',
  'other',
] as const;

// Two scopes only (§8). `projects` is the default; `global` is for knowledge true
// independently of every project, and should stay rare.
export const MEMORY_SCOPE_KINDS = ['projects', 'global'] as const;

// Soft deletion only (§10): a memory that no longer holds gets archived with a
// reason, and one that changed gets updated.
export const MEMORY_STATUSES = ['active', 'archived'] as const;

// Where the knowledge came from (§9).
export const PROVENANCE_SOURCES = [
  'user_stated',
  'agent_observed',
  'external_reference',
  'inferred',
] as const;

// How well it is established (§9). Ordered weakest to strongest.
export const VERIFICATION_LEVELS = [
  'unverified',
  'observed_once',
  'user_confirmed',
  'source_confirmed',
] as const;

// Kinds of durable reference an evidence entry can hold (§9: commit SHAs,
// permanent URLs, issue ids, stable paths).
//
// Five, with no `other`: anything unlisted — a vendor doc, a dashboard, a chat
// permalink — is a `url`, so the escape hatch exists without being a dumping
// ground. `pull_request` stays separate from `issue` because the report wants to
// tell "the change" from "the discussion", even though GitHub numbers them in one
// sequence.
export const EVIDENCE_KINDS = ['commit', 'pull_request', 'issue', 'url', 'path'] as const;

// Multi-project search semantics (v2.md §5): `any` matches memories associated
// with any supplied project, `all` only those associated with every one.
export const PROJECT_MATCH_MODES = ['any', 'all'] as const;

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export const memoryScopeKindSchema = z.enum(MEMORY_SCOPE_KINDS);
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export const provenanceSourceSchema = z.enum(PROVENANCE_SOURCES);
export const verificationSchema = z.enum(VERIFICATION_LEVELS);
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const projectMatchModeSchema = z.enum(PROJECT_MATCH_MODES);

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_REASON_LENGTH = 280;
const MAX_EVIDENCE_VALUE_LENGTH = 500;
const MAX_EVIDENCE_NOTE_LENGTH = 200;

// A memory scoped to more than a handful of projects is either global or too
// vague to retrieve well; the cap makes that a validation error rather than a
// slow accumulation.
const MAX_PROJECT_IDS = 10;

// Shape cap on evidence. Overflow *within* one call is a validation error;
// overflow produced by merging an update into an existing record is soft and
// handled in memory-fields.ts, because neither side violated the shape.
export const MAX_EVIDENCE_ENTRIES = 10;

// Generous enough for a thorough write-up, tight enough that pasted third-party
// documentation (§3 forbids it) fails mechanically rather than on review.
export const MAX_BODY_LENGTH = 12000;

const nonEmpty = z.string().trim().min(1);
const titleSchema = nonEmpty.max(MAX_TITLE_LENGTH);
const descriptionSchema = nonEmpty.max(MAX_DESCRIPTION_LENGTH);
const reasonSchema = nonEmpty.max(MAX_REASON_LENGTH);
const bodySchema = nonEmpty.max(MAX_BODY_LENGTH);

const memoryIdSchema = z.string().regex(MEMORY_ID_PATTERN, 'must be a mem_-prefixed identifier');
const projectIdSchema = z.string().regex(PROJECT_ID_PATTERN, 'must be a prj_-prefixed project id');

const projectIdsSchema = z.array(projectIdSchema).min(1).max(MAX_PROJECT_IDS);

/**
 * Scope, as a discriminated union rather than a kind plus a conditionally-present
 * array.
 *
 * The `global` branch being strict is the point: `{ kind: 'global', project_ids:
 * [...] }` is a contradiction, and rejecting it names the mistake instead of
 * silently dropping the ids and filing the memory where nothing will find it.
 */
export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects'), project_ids: projectIdsSchema }).strict(),
  z.object({ kind: z.literal('global') }).strict(),
]);

export const evidenceEntrySchema = z
  .object({
    kind: evidenceKindSchema,
    value: nonEmpty.max(MAX_EVIDENCE_VALUE_LENGTH),
    // Why this reference matters, when the value alone will not say. Optional and
    // short: it disambiguates, it is not a second body.
    note: nonEmpty.max(MAX_EVIDENCE_NOTE_LENGTH).optional(),
  })
  .strict();

const evidenceListSchema = z.array(evidenceEntrySchema).max(MAX_EVIDENCE_ENTRIES);

// Persisted provenance: `verification` is always present on disk, defaulted from
// `source` per the §9 table when the agent did not state one.
export const provenanceSchema = z
  .object({
    source: provenanceSourceSchema,
    verification: verificationSchema,
    evidence: evidenceListSchema.optional(),
  })
  .strict();

/**
 * Full persisted front matter, in canonical field order.
 *
 * Lifecycle fields (`id`, `status`, both timestamps, `last_verified_at`,
 * `archive_reason`) are server-managed; the rest are agent-supplied.
 */
export const memoryFrontmatterSchema = z
  .object({
    id: memoryIdSchema,
    title: titleSchema,
    description: descriptionSchema,
    scope: memoryScopeSchema,
    type: memoryTypeSchema,
    provenance: provenanceSchema,
    status: memoryStatusSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    last_verified_at: z.iso.datetime().optional(),
    archive_reason: reasonSchema.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    // §10 archives always carry a reason, and a reason on an active memory is a
    // leftover from a restore that did not clean up — either way the record does
    // not say what it means.
    if (record.status === 'archived' && record.archive_reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'An archived memory must carry an archive_reason (docs/memory-policy.md §10).',
        path: ['archive_reason'],
      });
    }
    if (record.status === 'active' && record.archive_reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'archive_reason is only valid on an archived memory; restoring clears it.',
        path: ['archive_reason'],
      });
    }
  });

// `create_memory` provenance: `source` is required, `verification` optional and
// defaulted (§9), `evidence` optional.
export const createProvenanceInputSchema = z
  .object({
    source: provenanceSourceSchema,
    verification: verificationSchema.optional(),
    evidence: evidenceListSchema.optional(),
  })
  .strict();

/**
 * `create_memory` input (v2.md §5).
 *
 * Exposed as a raw shape so the MCP layer can advertise and pre-validate it; the
 * derived object schema drives our own validate(), so the operation is correct
 * when called directly. Server-managed fields are absent and, the object being
 * strict, rejected if supplied.
 */
export const createMemoryInputShape = {
  title: titleSchema,
  description: descriptionSchema,
  scope: memoryScopeSchema,
  type: memoryTypeSchema,
  body: bodySchema,
  provenance: createProvenanceInputSchema,
  // The dedupe gate's escape hatch. §5: never pass it by reflex — hence a reason
  // rather than a bare boolean.
  force_create: z.boolean().optional(),
  force_create_reason: reasonSchema.optional(),
} as const;

export const createMemoryInputSchema = z
  .object(createMemoryInputShape)
  .strict()
  .superRefine((input, ctx) => {
    if (input.force_create === true && input.force_create_reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'force_create requires force_create_reason: say why the near-duplicate should ' +
          'exist alongside the candidates (docs/memory-policy.md §5).',
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

// `get_memory` input: a memory is read by its stable id alone.
export const getMemoryInputShape = {
  id: memoryIdSchema,
} as const;

export const getMemoryInputSchema = z.object(getMemoryInputShape).strict();

/**
 * Search scope: required, and strict about what it covers.
 *
 * A `projects` search returns project-scoped memories only — `global` ones need
 * their own call. That is the narrow reading of "requires an explicit scope"
 * (v2.md §5), and it means a `preference` memory will not surface incidentally
 * while working in a project. If that turns out to matter, the fix is an
 * instruction telling agents to run the second search, not a scope that quietly
 * widens.
 */
export const searchScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('projects'),
      project_ids: projectIdsSchema,
      match: projectMatchModeSchema.default('any'),
    })
    .strict(),
  z.object({ kind: z.literal('global') }).strict(),
]);

/**
 * `search_memories` input (v2.md §5).
 *
 * `status` defaults to active-only, so archived memories are excluded unless
 * explicitly requested. `intent` is advisory: it never touches retrieval and
 * exists so the event log can record what the agent thought it was doing.
 */
export const searchMemoriesInputShape = {
  query: nonEmpty,
  scope: searchScopeSchema,
  types: z.array(memoryTypeSchema).min(1).optional(),
  status: z.array(memoryStatusSchema).min(1).default(['active']),
  intent: nonEmpty.optional(),
  limit: z.number().int().min(1).optional(),
} as const;

export const searchMemoriesInputSchema = z.object(searchMemoriesInputShape).strict();

// A provenance patch: any subset, but not an empty object — that is a caller
// mistake worth surfacing rather than a no-op to absorb.
export const provenancePatchSchema = z
  .object({
    source: provenanceSourceSchema.optional(),
    verification: verificationSchema.optional(),
    evidence: evidenceListSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'provenance must change at least one of: source, verification, evidence.',
  });

/**
 * Editable metadata for `update_memory`.
 *
 * `status` accepts `active` only. Archiving goes through `archive_memory`, which
 * requires a reason — routing it here as well would be a reason-free back door
 * into the one state §10 says must always be explained.
 */
export const updateMemoryChangesShape = {
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  scope: memoryScopeSchema.optional(),
  type: memoryTypeSchema.optional(),
  status: z.literal('active').optional(),
  provenance: provenancePatchSchema.optional(),
} as const;

/**
 * `update_memory` input.
 *
 * An edit is metadata `changes`, a body edit (full replacement or an exact-match
 * `old_text`/`new_text` swap as an anti-clobber guard), a
 * re-verification stamp, or any combination. `replace` switches the array fields
 * from merge-append to overwrite, matching `update_project`, because the common
 * call adds one reference and must not silently drop the others.
 */
export const updateMemoryInputShape = {
  id: memoryIdSchema,
  changes: z.object(updateMemoryChangesShape).strict().optional(),
  body: bodySchema.optional(),
  old_text: z.string().optional(),
  new_text: z.string().optional(),
  // "I re-checked this and it still holds" (§9). A boolean, not a timestamp: the
  // server stamps `last_verified_at` so an agent cannot backdate a verification,
  // exactly as `last_seen_at` works on the project side.
  mark_verified: z.boolean().optional(),
  replace: z.boolean().optional(),
} as const;

export const updateMemoryInputSchema = z
  .object(updateMemoryInputShape)
  .strict()
  .superRefine((input, ctx) => {
    const hasChanges = input.changes !== undefined && Object.keys(input.changes).length > 0;
    const hasOldText = input.old_text !== undefined;
    const hasNewText = input.new_text !== undefined;
    const hasBody = input.body !== undefined;
    const marksVerified = input.mark_verified === true;

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
    if (!hasChanges && !hasBody && !hasOldText && !marksVerified) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide at least one of: changes, body, old_text/new_text, or mark_verified.',
        path: [],
      });
    }

    // The only mergeable arrays are evidence and project_ids, so `replace`
    // without one of them present is a misunderstanding of what it does.
    const suppliesArray =
      input.changes?.provenance?.evidence !== undefined ||
      input.changes?.scope?.kind === 'projects';
    if (input.replace !== undefined && !suppliesArray) {
      ctx.addIssue({
        code: 'custom',
        message:
          'replace has no effect without provenance.evidence or a projects scope to replace.',
        path: ['replace'],
      });
    }
  });

/**
 * `archive_memory` input.
 *
 * The reason is required. `docs/memory-policy.md` §10 ("archive rather than delete,
 * always with a reason") is frozen and canonical, so it wins over v2.md §5's
 * looser "optionally accepts an archive reason"; a memory that stopped being true
 * without a note explaining why is a worse artifact than no memory at all.
 */
export const archiveMemoryInputShape = {
  id: memoryIdSchema,
  reason: reasonSchema,
} as const;

export const archiveMemoryInputSchema = z.object(archiveMemoryInputShape).strict();

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryScopeKind = z.infer<typeof memoryScopeKindSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;
export type VerificationLevel = z.infer<typeof verificationSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceEntry = z.infer<typeof evidenceEntrySchema>;
export type MemoryProvenance = z.infer<typeof provenanceSchema>;
export type MemoryRecord = z.infer<typeof memoryFrontmatterSchema>;
export type ProjectMatchMode = z.infer<typeof projectMatchModeSchema>;
export type CreateMemoryInput = z.infer<typeof createMemoryInputSchema>;
export type CreateProvenanceInput = z.infer<typeof createProvenanceInputSchema>;
export type GetMemoryInput = z.infer<typeof getMemoryInputSchema>;
export type SearchMemoriesInput = z.infer<typeof searchMemoriesInputSchema>;
export type SearchScope = z.infer<typeof searchScopeSchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;
export type ProvenancePatch = z.infer<typeof provenancePatchSchema>;
export type ArchiveMemoryInput = z.infer<typeof archiveMemoryInputSchema>;

/**
 * An evidence entry a write path refused, and why.
 *
 * Reported, never fatal: evidence is optional metadata, and V2 exists to raise
 * how often agents reach for the tools at all. Failing a whole create over one
 * malformed reference risks the agent giving up and the insight being lost.
 */
export interface DroppedEvidence {
  kind: EvidenceKind;
  value: string;
  why: string;
}

/**
 * The lightweight shape `search_memories` returns (v2.md §3): enough to decide
 * whether a memory is worth a `get_memory` call, with no body and no provenance.
 */
export interface MemorySummary {
  id: string;
  title: string;
  description: string;
  scope: MemoryScope;
  type: MemoryType;
  status: MemoryStatus;
  updated_at: string;
}

export interface SearchResultItem extends MemorySummary {
  score: number;
}

/**
 * A memory the dedupe gate is offering instead of creating, with the score that
 * surfaced it. The number is reported so an agent can tell a restatement from a
 * neighbour, not because it is meaningful in itself.
 */
export interface MemoryCandidate extends MemorySummary {
  similarity: number;
}

// A project id paired with the name it resolves to, or null when the registry
// holds no such project (a hand-deleted record, or a memory written against an
// id that never existed).
export interface MemoryProjectRef {
  id: string;
  name: string | null;
}

/**
 * The full shape `get_memory` returns: the record, its body, and the project
 * names its ids stand for. Resolving the names costs one registry read and is the
 * difference between an agent understanding a memory's scope and seeing an opaque
 * `prj_` token.
 */
export interface MemoryDetail extends MemoryRecord {
  body: string;
  projects: MemoryProjectRef[];
}

export function toMemorySummary(record: MemoryRecord): MemorySummary {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    scope: record.scope,
    type: record.type,
    status: record.status,
    updated_at: record.updated_at,
  };
}

/** Project ids a memory is scoped to; empty for a global memory. */
export function memoryProjectIds(record: MemoryRecord): string[] {
  return record.scope.kind === 'projects' ? [...record.scope.project_ids] : [];
}

// Validate a parsed front-matter mapping against the canonical schema, throwing a
// per-field validation_error on any vocabulary or shape violation.
export function validateMemoryFrontmatter(metadata: unknown): MemoryRecord {
  return validate(memoryFrontmatterSchema, metadata);
}
