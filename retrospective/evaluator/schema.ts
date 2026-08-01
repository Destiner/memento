import { z } from 'zod';

import {
  createMemoryInputShape,
  getMemoryInputSchema,
  searchMemoriesInputShape,
} from '../../src/store/memory-schema.js';

export const EVALUATOR_SCHEMA_VERSION = '2' as const;
export const MAX_CHECKPOINTS = 6;
export const MAX_SEARCH_PROPOSALS = 3;
export const MAX_CAPTURE_PROPOSALS = 3;

const nonEmpty = z.string().trim().min(1);

export const evaluatorRunSchema = z
  .object({
    provider: z.enum(['claude-code', 'codex']),
    cli: z.enum(['claude', 'codex']),
    cliVersion: nonEmpty,
    model: nonEmpty,
    promptVersion: nonEmpty,
    schemaVersion: nonEmpty,
    policyVersion: nonEmpty,
  })
  .strict();

export const checkpointSchema = z
  .object({
    id: nonEmpty,
    eventId: nonEmpty,
    sequence: z.number().int().nonnegative(),
    kind: z.enum(['start', 'meaningful']),
    reason: nonEmpty.max(280),
  })
  .strict();

export const checkpointPlanSchema = z
  .object({
    schemaVersion: z.literal(EVALUATOR_SCHEMA_VERSION),
    taskId: nonEmpty,
    checkpoints: z.array(checkpointSchema).min(1).max(MAX_CHECKPOINTS),
    evaluator: evaluatorRunSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.checkpoints[0]?.kind !== 'start') {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoints', 0],
        message: 'first checkpoint must be start',
      });
    }

    const eventIds = new Set<string>();
    let previousSequence = -1;
    plan.checkpoints.forEach((checkpoint, index) => {
      if (eventIds.has(checkpoint.eventId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', index, 'eventId'],
          message: 'checkpoint event ids must be unique',
        });
      }
      eventIds.add(checkpoint.eventId);
      if (checkpoint.sequence < previousSequence) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', index, 'sequence'],
          message: 'checkpoints must be chronological',
        });
      }
      previousSequence = checkpoint.sequence;
    });
  });

export const checkpointCandidateBatchSchema = z
  .object({
    checkpoints: z
      .array(
        z
          .object({
            eventId: nonEmpty,
            reason: nonEmpty.max(280),
          })
          .strict(),
      )
      .max(MAX_CHECKPOINTS - 1),
  })
  .strict();

export const unresolvedProjectScopeSchema = z
  .object({ kind: z.literal('unresolved_projects') })
  .strict();

const proposedSearchScopeSchema = z.union([
  searchMemoriesInputShape.scope,
  unresolvedProjectScopeSchema,
]);

const proposedSearchInputSchema = z
  .object({
    query: searchMemoriesInputShape.query,
    scope: proposedSearchScopeSchema,
    types: searchMemoriesInputShape.types,
    intent: searchMemoriesInputShape.intent,
  })
  .strict();

export const searchProposalSchema = z
  .object({
    kind: z.literal('search'),
    checkpointId: nonEmpty,
    search: proposedSearchInputSchema,
    rationale: nonEmpty.max(500),
  })
  .strict();

export const searchProposalBatchSchema = z
  .object({
    proposals: z.array(searchProposalSchema).max(MAX_SEARCH_PROPOSALS),
  })
  .strict();

const proposedMemoryScopeSchema = z.union([
  createMemoryInputShape.scope,
  unresolvedProjectScopeSchema,
]);

const proposedMemorySchema = z
  .object({
    title: createMemoryInputShape.title,
    description: createMemoryInputShape.description,
    scope: proposedMemoryScopeSchema,
    type: createMemoryInputShape.type,
    body: createMemoryInputShape.body,
    provenance: createMemoryInputShape.provenance,
  })
  .strict();
const memoryIdSchema = getMemoryInputSchema.shape.id;

export const captureProposalSchema = z
  .object({
    kind: z.literal('capture'),
    taskId: nonEmpty,
    action: z.enum(['create', 'update']),
    targetMemoryId: memoryIdSchema.nullable(),
    memory: proposedMemorySchema,
    rationale: nonEmpty.max(500),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (proposal.action === 'create' && proposal.targetMemoryId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetMemoryId'],
        message: 'create proposals cannot target an existing memory',
      });
    }
  });

export const captureProposalBatchSchema = z
  .object({
    summary: nonEmpty.max(1_200),
    proposals: z.array(captureProposalSchema).max(MAX_CAPTURE_PROPOSALS),
  })
  .strict();

export const searchEvaluationSchema = z
  .object({
    checkpoint: checkpointSchema,
    proposals: z.array(searchProposalSchema).max(MAX_SEARCH_PROPOSALS),
    evaluator: evaluatorRunSchema,
  })
  .strict();

export const captureEvaluationSchema = z
  .object({
    summary: nonEmpty.max(1_200),
    proposals: z.array(captureProposalSchema).max(MAX_CAPTURE_PROPOSALS),
    evaluator: evaluatorRunSchema,
  })
  .strict();

export const comparisonClassificationSchema = z.enum([
  'timely',
  'late',
  'missed',
  'unnecessary_candidate',
  'incorrect_scope',
  'ambiguous',
  'transcript_only',
  'attempted_not_stored',
]);

export const operationComparisonSchema = z
  .object({
    kind: z.enum(['search', 'capture']),
    proposalIndex: z.number().int().nonnegative().nullable(),
    actualOperationIds: z.array(nonEmpty).max(1),
    classification: comparisonClassificationSchema,
    explanation: nonEmpty.max(500),
  })
  .strict();

export const analysisResultSchema = z
  .object({
    schemaVersion: z.literal(EVALUATOR_SCHEMA_VERSION),
    taskId: nonEmpty,
    checkpointPlan: checkpointPlanSchema,
    searchEvaluations: z.array(searchEvaluationSchema).max(MAX_CHECKPOINTS),
    captureEvaluation: captureEvaluationSchema,
    comparisons: z.array(operationComparisonSchema),
  })
  .strict();

export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointPlan = z.infer<typeof checkpointPlanSchema>;
export type CheckpointCandidateBatch = z.infer<typeof checkpointCandidateBatchSchema>;
export type SearchProposal = z.infer<typeof searchProposalSchema>;
export type SearchProposalBatch = z.infer<typeof searchProposalBatchSchema>;
export type CaptureProposal = z.infer<typeof captureProposalSchema>;
export type CaptureProposalBatch = z.infer<typeof captureProposalBatchSchema>;
export type EvaluatorRun = z.infer<typeof evaluatorRunSchema>;
export type SearchEvaluation = z.infer<typeof searchEvaluationSchema>;
export type CaptureEvaluation = z.infer<typeof captureEvaluationSchema>;
export type ComparisonClassification = z.infer<typeof comparisonClassificationSchema>;
export type OperationComparison = z.infer<typeof operationComparisonSchema>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
