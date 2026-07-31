// MCP output schemas for the eight tools (v2.md §4, §5).
//
// These live apart from the operations for one reason: the MCP SDK advertises an
// output schema as a raw object shape, so a top-level discriminated union is not
// expressible. `resolve_project`, `create_project`, and `create_memory` all have
// two shapes of answer, and they are flattened here into one object carrying a
// required `outcome` plus the branch fields — the operations keep the real union
// internally, and the JSON an agent reads stays shallow.
//
// Field names and enums are the schema's, not restatements: everything comes from
// the vocabularies frozen in memory-schema.ts and project-schema.ts.

import { z } from 'zod';

import {
  MEMORY_SCOPE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PROVENANCE_SOURCES,
  VERIFICATION_LEVELS,
  EVIDENCE_KINDS,
} from './store/memory-schema.js';
import { PROJECT_STATUSES } from './store/project-schema.js';

const memoryScope = z.object({
  kind: z.enum(MEMORY_SCOPE_KINDS),
  project_ids: z.array(z.string()).optional(),
});

const memorySummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  scope: memoryScope,
  type: z.enum(MEMORY_TYPES),
  status: z.enum(MEMORY_STATUSES),
  updated_at: z.string(),
});

// Reported, never fatal: an evidence entry the write path refused, and why.
const droppedEvidence = z.array(
  z.object({ kind: z.enum(EVIDENCE_KINDS), value: z.string(), why: z.string() }),
);

const projectSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(PROJECT_STATUSES),
});

const projectRecord = projectSummary.extend({
  aliases: z.array(z.string()).optional(),
  identifiers: z
    .object({
      git_remotes: z.array(z.string()).optional(),
      repository_slugs: z.array(z.string()).optional(),
    })
    .optional(),
  working_directories: z.array(z.object({ path: z.string(), last_seen_at: z.string() })).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const resolveProjectOutputShape = {
  outcome: z.enum(['exact_match', 'candidates', 'not_found']),
  // Which signal matched, so an agent can tell a directory hit from a name guess.
  matched_on: z.string().optional(),
  project: projectSummary.optional(),
  // Evidence the caller holds that the record does not: apply with update_project.
  suggestions: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
  candidates: z.array(projectSummary).optional(),
} as const;

export const createProjectOutputShape = {
  outcome: z.enum(['created', 'duplicate_candidates']),
  id: z.string().optional(),
  path: z.string().optional(),
  project: projectRecord.optional(),
  candidates: z.array(projectSummary.extend({ similarity: z.number() })).optional(),
} as const;

export const updateProjectOutputShape = {
  id: z.string(),
  path: z.string(),
  updated: z.boolean(),
  project: projectRecord,
} as const;

export const searchMemoriesOutputShape = {
  query_id: z.string(),
  results: z.array(memorySummary.extend({ score: z.number() })),
  result_count: z.number(),
} as const;

export const getMemoryOutputShape = {
  id: z.string(),
  title: z.string(),
  description: z.string(),
  scope: memoryScope,
  type: z.enum(MEMORY_TYPES),
  body: z.string(),
  provenance: z.object({
    source: z.enum(PROVENANCE_SOURCES),
    verification: z.enum(VERIFICATION_LEVELS),
    evidence: z
      .array(
        z.object({
          kind: z.enum(EVIDENCE_KINDS),
          value: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
  }),
  status: z.enum(MEMORY_STATUSES),
  created_at: z.string(),
  updated_at: z.string(),
  last_verified_at: z.string().optional(),
  archive_reason: z.string().optional(),
  // The names behind the scope's opaque project ids; null for a dangling id.
  projects: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
} as const;

export const createMemoryOutputShape = {
  outcome: z.enum(['created', 'duplicate_candidates']),
  id: z.string().optional(),
  path: z.string().optional(),
  memory: memorySummary.optional(),
  dropped_evidence: droppedEvidence.optional(),
  candidates: z.array(memorySummary.extend({ similarity: z.number() })).optional(),
} as const;

export const updateMemoryOutputShape = {
  id: z.string(),
  path: z.string(),
  updated: z.boolean(),
  memory: memorySummary,
  dropped_evidence: droppedEvidence,
} as const;

export const archiveMemoryOutputShape = {
  id: z.string(),
  path: z.string(),
  archived: z.boolean(),
  memory: memorySummary,
} as const;
