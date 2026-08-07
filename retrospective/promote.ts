import { createMemory, MemoryCreatedIndexError } from '../src/store/memory-create.js';
import { getMemory } from '../src/store/memory-get.js';
import {
  updateMemory,
  MemoryUpdatedPersistenceError,
  MemoryUpdateConflictError,
} from '../src/store/memory-update.js';
import { resolveProject } from '../src/store/project-resolve.js';
import { assertProjectsRegistered } from '../src/store/project-registry.js';
import { resolveVerification } from '../src/store/memory-fields.js';
import { openIndex } from '../src/store/index-open.js';
import { rebuildIndex } from '../src/store/rebuild.js';
import { resolvePaths } from '../src/config.js';
import type { MemoryScope } from '../src/store/memory-schema.js';
import type { MemoryIndex } from '../src/store/search-index.js';
import type { RetrospectiveStore } from './db/store.js';
import type { PromotionAttempt, ReviewQueueItem } from './db/types.js';
import { captureProposalSchema, type CaptureProposal } from './evaluator/schema.js';
import type { JsonValue, ProjectContext } from './model.js';
import { boundText, redactJson, redactText } from './redact.js';
import { targetMemorySnapshot } from './memory-snapshot.js';

export interface PromotionOperations {
  resolveProject: typeof resolveProject;
  assertProjectsRegistered: typeof assertProjectsRegistered;
  createMemory: typeof createMemory;
  getMemory: typeof getMemory;
  updateMemory: typeof updateMemory;
}

export interface PromotionOptions {
  memoriesDir: string;
  projectsDir: string;
  index: MemoryIndex;
  operations?: PromotionOperations;
}

const DEFAULT_OPERATIONS: PromotionOperations = {
  resolveProject,
  assertProjectsRegistered,
  createMemory,
  getMemory,
  updateMemory,
};

export async function promoteApprovedWrite(
  store: RetrospectiveStore,
  comparisonId: string,
  options: PromotionOptions,
): Promise<PromotionAttempt> {
  const item = store.reviewItem(comparisonId);
  if (item.kind !== 'write')
    throw new Error('Search proposals are evaluation-only and cannot promote.');
  if (item.state !== 'approved') {
    throw new Error(`Review item ${comparisonId} must be approved before promotion.`);
  }
  if (!isPromotionEligible(item)) {
    throw new Error(
      `Review item ${comparisonId} has an actual memory operation without objective failure ` +
        'evidence; refusing to write it again.',
    );
  }
  const rawProposal = item.revision ?? item.proposal;
  if (rawProposal === undefined) throw new Error('Approved write has no proposal to promote.');
  const proposal = captureProposalSchema.parse(rawProposal);
  if (proposal.memory.scope.kind === 'unresolved_projects') {
    throw new Error(
      'An unresolved_projects scope cannot be promoted. Append an edit review with a canonical ' +
        'projects scope before promotion.',
    );
  }
  const claim = store.claimPromotion(comparisonId, asJson(proposal), item.reviewEvents.length);
  const attempt = claim.attempt;
  if (!claim.claimed) return attempt;

  const operations = options.operations ?? DEFAULT_OPERATIONS;
  let successfulResult: unknown;
  let promotedMemoryId: string;
  try {
    const scope = await resolveScope(
      proposal,
      store.projectContextForComparison(comparisonId),
      options.projectsDir,
      operations,
      item.revision !== undefined,
    );
    if (scope.outcome === 'ambiguous') {
      return store.finishPromotion(attempt.id, {
        status: 'ambiguous',
        result: { reason: scope.reason },
      });
    }

    const memory = { ...proposal.memory, scope: scope.scope };
    if (proposal.action === 'create') {
      const result = await operations.createMemory(memory, {
        memoriesDir: options.memoriesDir,
        projectsDir: options.projectsDir,
        index: options.index,
      });
      if (result.outcome === 'duplicate_candidates') {
        return store.finishPromotion(attempt.id, {
          status: 'duplicate_candidates',
          result: safePromotionResult(result),
        });
      }
      successfulResult = result;
      promotedMemoryId = result.id;
    } else {
      if (proposal.targetMemoryId === null) {
        return store.finishPromotion(attempt.id, {
          status: 'ambiguous',
          result: { reason: 'An update proposal needs a reviewed target memory id.' },
        });
      }
      if (
        item.targetMemorySnapshot === undefined ||
        item.targetMemorySnapshot.memoryId !== proposal.targetMemoryId
      ) {
        return store.finishPromotion(attempt.id, {
          status: 'ambiguous',
          result: {
            reason:
              'The update target was not snapshotted during review. Append a review edit to ' +
              'confirm the current target before promotion.',
          },
        });
      }
      const current = await operations.getMemory(
        { id: proposal.targetMemoryId },
        { memoriesDir: options.memoriesDir, projectsDir: options.projectsDir },
      );
      if (current.status === 'archived') {
        return store.finishPromotion(attempt.id, {
          status: 'ambiguous',
          result: {
            reason:
              'The reviewed update target is archived. Restore it explicitly, then append a ' +
              'review edit against the active record before promotion.',
          },
        });
      }
      if (targetMemorySnapshot(current).sha256 !== item.targetMemorySnapshot.sha256) {
        return store.finishPromotion(attempt.id, {
          status: 'ambiguous',
          result: {
            reason:
              'The target memory changed after review. Append a review edit against the current ' +
              'memory before promotion.',
          },
        });
      }
      const result = await operations.updateMemory(
        {
          id: proposal.targetMemoryId,
          changes: {
            title: memory.title,
            description: memory.description,
            scope: memory.scope,
            type: memory.type,
            provenance: {
              ...memory.provenance,
              verification: resolveVerification(
                memory.provenance.source,
                memory.provenance.verification,
              ),
              evidence: memory.provenance.evidence ?? [],
            },
          },
          old_text: current.body,
          new_text: memory.body,
          replace: true,
        },
        {
          memoriesDir: options.memoriesDir,
          projectsDir: options.projectsDir,
          index: options.index,
          expectedCurrentSha256: item.targetMemorySnapshot.sha256,
        },
      );
      successfulResult = result;
      promotedMemoryId = result.id;
    }
  } catch (error) {
    if (error instanceof MemoryUpdateConflictError) {
      return store.finishPromotion(attempt.id, {
        status: 'ambiguous',
        result: {
          reason:
            'The target memory changed while promotion was starting. Append a review edit ' +
            'against the current memory before retrying.',
        },
      });
    }
    if (
      error instanceof MemoryCreatedIndexError ||
      error instanceof MemoryUpdatedPersistenceError
    ) {
      throw error;
    }
    return store.finishPromotion(attempt.id, {
      status: 'failed',
      error: safePromotionError(error),
    });
  }
  return store.finishPromotion(attempt.id, {
    status: 'succeeded',
    result: safePromotionResult(successfulResult),
    promotedMemoryId,
  });
}

export function isPromotionEligible(item: ReviewQueueItem): boolean {
  return (
    item.kind === 'write' &&
    item.state === 'approved' &&
    item.proposalId !== undefined &&
    (item.actualOperationId === undefined || actualWriteDidNotStore(item.actualOperation))
  );
}

export async function promoteApprovedWriteFromHome(
  store: RetrospectiveStore,
  comparisonId: string,
  home: string,
): Promise<PromotionAttempt> {
  const paths = resolvePaths(home);
  const opened = await openIndex({ indexDir: paths.index, memoriesDir: paths.memories });
  try {
    return await promoteApprovedWrite(store, comparisonId, {
      memoriesDir: paths.memories,
      projectsDir: paths.projects,
      index: opened.index,
    });
  } finally {
    opened.index.close();
  }
}

export async function reconcileStartedPromotionFromHome(
  store: RetrospectiveStore,
  comparisonId: string,
  outcome:
    | { status: 'succeeded'; actor: string; reason: string; memoryId: string; home: string }
    | { status: 'failed'; actor: string; reason: string; home: string },
): Promise<PromotionAttempt> {
  const item = store.reviewItem(comparisonId);
  if (item.kind !== 'write' || item.state !== 'approved') {
    throw new Error('Only an approved write can have a promotion reconciled.');
  }
  const attempt = store.latestPromotion(comparisonId);
  if (attempt?.status !== 'started') {
    throw new Error(`Review item ${comparisonId} has no started promotion to reconcile.`);
  }
  if (outcome.actor.trim() === '' || outcome.reason.trim() === '') {
    throw new Error('Promotion reconciliation requires an actor and reason.');
  }

  const audit = safePromotionResult({
    outcome: 'manually_reconciled',
    actor: outcome.actor.trim(),
    reason: outcome.reason.trim(),
  });
  if (outcome.status === 'failed') {
    return store.finishPromotion(attempt.id, {
      status: 'failed',
      result: audit,
      error: safePromotionError(`Manual reconciliation: ${outcome.reason}`),
    });
  }

  const paths = resolvePaths(outcome.home);
  const claimedProposal = captureProposalSchema.parse(attempt.proposal);
  if (claimedProposal.action === 'update' && claimedProposal.targetMemoryId !== outcome.memoryId) {
    throw new Error(
      `The reconciled memory id must match update target ${claimedProposal.targetMemoryId}.`,
    );
  }
  const opened = await openIndex({ indexDir: paths.index, memoriesDir: paths.memories });
  try {
    const memory = await getMemory(
      { id: outcome.memoryId },
      { memoriesDir: paths.memories, projectsDir: paths.projects },
    );
    const rebuilt = await rebuildIndex(opened.index, paths.memories);
    if (rebuilt.skipped.length > 0) {
      throw new Error(
        `Index reconciliation skipped ${rebuilt.skipped.length} memory file(s); ` +
          'repair the canonical store before marking promotion succeeded.',
      );
    }
    return store.finishPromotion(attempt.id, {
      status: 'succeeded',
      result: audit,
      promotedMemoryId: memory.id,
    });
  } finally {
    opened.index.close();
  }
}

type ResolvedScope =
  { outcome: 'resolved'; scope: MemoryScope } | { outcome: 'ambiguous'; reason: string };

async function resolveScope(
  proposal: CaptureProposal,
  context: ProjectContext | undefined,
  projectsDir: string,
  operations: PromotionOperations,
  allowReviewedScopeOverride = false,
): Promise<ResolvedScope> {
  if (proposal.memory.scope.kind === 'global') {
    return { outcome: 'resolved', scope: { kind: 'global' } };
  }
  if (proposal.memory.scope.kind === 'unresolved_projects') {
    return {
      outcome: 'ambiguous',
      reason: 'The proposal needs an append-only review edit to a canonical project scope.',
    };
  }
  const proposedIds = proposal.memory.scope.project_ids;
  await operations.assertProjectsRegistered(projectsDir, proposedIds);
  if (allowReviewedScopeOverride) {
    return {
      outcome: 'resolved',
      scope: { kind: 'projects', project_ids: proposedIds },
    };
  }
  // An incomplete resolution may omit a project but never contains a wrong id, so a proposal
  // confined to the resolved set still promotes; the subset check below is the real guard.
  if ((context?.projectIds?.length ?? 0) > 0) {
    const resolvedIds = new Set(context?.projectIds ?? []);
    if (!proposedIds.every((id) => resolvedIds.has(id))) {
      return {
        outcome: 'ambiguous',
        reason: 'The proposed scope differs from the project ids resolved during ingestion.',
      };
    }
    return {
      outcome: 'resolved',
      scope: { kind: 'projects', project_ids: proposedIds },
    };
  }
  const evidence = resolutionEvidence(context);
  if (Object.keys(evidence).length === 0) {
    return {
      outcome: 'ambiguous',
      reason: 'No non-redacted project identity is available for promotion-time resolution.',
    };
  }
  const resolved = await operations.resolveProject(evidence, { projectsDir });
  if (resolved.outcome !== 'exact_match') {
    return {
      outcome: 'ambiguous',
      reason: `Promotion-time project resolution returned ${resolved.outcome}.`,
    };
  }
  if (proposedIds.length > 1) {
    if (!proposedIds.includes(resolved.project.id)) {
      return {
        outcome: 'ambiguous',
        reason: 'The resolved current project is absent from the proposed multi-project scope.',
      };
    }
    return {
      outcome: 'resolved',
      scope: { kind: 'projects', project_ids: proposedIds },
    };
  }
  if (proposedIds[0] !== resolved.project.id) {
    return {
      outcome: 'ambiguous',
      reason: 'The proposed project id differs from promotion-time project resolution.',
    };
  }
  return {
    outcome: 'resolved',
    scope: { kind: 'projects', project_ids: proposedIds },
  };
}

function actualWriteDidNotStore(operation: JsonValue | undefined): boolean {
  const record = recordValue(operation);
  const telemetry = recordValue(record?.telemetry);
  return (
    telemetry?.resultOutcome === 'duplicate_candidates' ||
    hasNestedOutcome(record?.output, 'duplicate_candidates')
  );
}

function hasNestedOutcome(value: JsonValue | undefined, expected: string): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some((entry) => hasNestedOutcome(entry, expected));
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      ((key === 'outcome' || key === 'result_outcome') && entry === expected) ||
      hasNestedOutcome(entry, expected),
  );
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function resolutionEvidence(context: ProjectContext | undefined): Record<string, string> {
  if (context === undefined) return {};
  const evidence: Record<string, string> = {};
  if (context.gitRemote) evidence.git_remote = context.gitRemote;
  if (context.repositorySlug) evidence.repository_slug = context.repositorySlug;
  if (context.workingDirectoryName) evidence.name_hint = context.workingDirectoryName;
  if (context.workingDirectory && !looksRedacted(context.workingDirectory)) {
    evidence.working_directory = context.workingDirectory;
  }
  return evidence;
}

function looksRedacted(value: string): boolean {
  return value.includes('[REDACTED') || value.startsWith('<path:') || value.startsWith('[path:');
}

function safePromotionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactText(message);
  return redacted.ok
    ? boundText(redacted.value)
    : 'Promotion failed; diagnostic withheld because it could not be safely redacted.';
}

function safePromotionResult(result: unknown): JsonValue {
  const redacted = redactJson(result);
  return redacted.ok
    ? redacted.value
    : { outcome: 'completed', detail: 'Result withheld because it could not be safely redacted.' };
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
