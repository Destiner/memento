import { captureProposalSchema, searchProposalSchema } from './evaluator/schema.js';
import { resolvePaths } from '../src/config.js';
import { getMemory } from '../src/store/memory-get.js';
import { getMemoryInputSchema } from '../src/store/memory-schema.js';
import type { RetrospectiveStore } from './db/store.js';
import type { JsonValue } from './model.js';
import { targetMemorySnapshot, type TargetMemorySnapshot } from './memory-snapshot.js';
import { boundText, redactJson, redactText } from './redact.js';
import type { ComparisonLabel, ReviewCommand, ReviewEvent, ReviewQueueItem } from './db/types.js';

export function reviewQueue(store: RetrospectiveStore, runId?: string): ReviewQueueItem[] {
  return store.listReviewQueue(runId);
}

export function reviewedItems(store: RetrospectiveStore, runId?: string): ReviewQueueItem[] {
  return store.listReviewed(runId);
}

export function applyReview(
  store: RetrospectiveStore,
  comparisonId: string,
  command: ReviewCommand,
  targetSnapshot?: TargetMemorySnapshot | null,
): ReviewEvent {
  const item = store.reviewItem(comparisonId);
  if (command.action !== 'approve') {
    const reason = redactText(command.reason);
    if (!reason.ok) throw new Error(`Review reason failed redaction: ${reason.reason}`);
    command = { ...command, reason: boundText(reason.value) };
  }
  if (command.action === 'approve' && hasUnresolvedWriteScope(item.proposal)) {
    throw new Error(
      'A write with unresolved_projects scope must be edited to a canonical scope before approval.',
    );
  }
  if (command.action === 'edit') {
    if (item.proposal === undefined)
      throw new Error('An actual-only review item cannot be edited.');
    const redacted = redactJson(command.revision);
    if (!redacted.ok) throw new Error(`Review revision failed redaction: ${redacted.reason}`);
    validateRevision(item, redacted.value);
    validateReviewedMatch(command.label, command.actualOperationId);
    command = { ...command, revision: redacted.value };
  }
  if (command.action === 'duplicate') {
    if (item.kind !== 'write' || item.proposal === undefined) {
      throw new Error('Only proposed memory writes can be marked as duplicates.');
    }
    getMemoryInputSchema.parse({ id: command.targetMemoryId });
  }
  return store.recordReview(comparisonId, {
    ...command,
    ...(targetSnapshot === undefined ? {} : { targetMemorySnapshot: targetSnapshot }),
  });
}

function validateReviewedMatch(label: ComparisonLabel, actualOperationId: string | null): void {
  if (actualOperationId === null && label !== 'missed') {
    throw new Error('An edit without an actual-operation match must use the missed label.');
  }
  if (actualOperationId !== null && (label === 'missed' || label === 'unnecessary_candidate')) {
    throw new Error(`${label} cannot be attached to an actual-operation match.`);
  }
}

export async function applyReviewFromHome(
  store: RetrospectiveStore,
  comparisonId: string,
  command: ReviewCommand,
  home: string,
): Promise<ReviewEvent> {
  const paths = resolvePaths(home);
  if (command.action === 'duplicate') {
    await getMemory(
      { id: command.targetMemoryId },
      { memoriesDir: paths.memories, projectsDir: paths.projects },
    );
  }
  let snapshot: TargetMemorySnapshot | null | undefined;
  if (command.action === 'approve' || command.action === 'edit') {
    const item = store.reviewItem(comparisonId);
    const proposalValue =
      command.action === 'edit' ? command.revision : (item.revision ?? item.proposal);
    const proposal =
      proposalValue === undefined ? undefined : captureProposalSchema.safeParse(proposalValue);
    if (proposal?.success && proposal.data.action === 'update') {
      if (proposal.data.targetMemoryId === null) {
        throw new Error('An approved update requires a target memory id.');
      }
      const memory = await getMemory(
        { id: proposal.data.targetMemoryId },
        { memoriesDir: paths.memories, projectsDir: paths.projects },
      );
      snapshot = targetMemorySnapshot(memory);
    } else {
      snapshot = null;
    }
  }
  return applyReview(store, comparisonId, command, snapshot);
}

export function renderReviewItem(item: ReviewQueueItem): string {
  const lines = [
    `${item.id} [${item.kind}] ${item.label}`,
    item.explanation,
    `State: ${item.state}`,
  ];
  if (item.label !== item.originalLabel) lines.push(`Original label: ${item.originalLabel}`);
  if (item.taskSummary !== undefined) lines.push(`Task summary: ${item.taskSummary}`);
  if (item.context !== undefined) lines.push(`Context: ${JSON.stringify(item.context, null, 2)}`);
  if (item.proposal !== undefined)
    lines.push(`Proposal: ${JSON.stringify(item.proposal, null, 2)}`);
  if (item.revision !== undefined)
    lines.push(`Reviewed proposal: ${JSON.stringify(item.revision, null, 2)}`);
  if (item.actualOperation !== undefined) {
    lines.push(`Actual operation: ${JSON.stringify(item.actualOperation, null, 2)}`);
  }
  if (item.actualOperationId !== undefined) {
    lines.push(`Actual operation id: ${item.actualOperationId}`);
  }
  if (item.originalActualOperationId !== item.actualOperationId) {
    lines.push(`Original actual operation id: ${item.originalActualOperationId ?? 'none'}`);
  }
  return lines.join('\n');
}

function validateRevision(item: ReviewQueueItem, revision: JsonValue): void {
  if (item.kind === 'search') {
    searchProposalSchema.parse(revision);
    return;
  }
  const proposal = captureProposalSchema.parse(revision);
  if (proposal.memory.scope.kind === 'unresolved_projects') {
    throw new Error('A write review edit must replace unresolved_projects with a canonical scope.');
  }
}

function hasUnresolvedWriteScope(proposal: JsonValue | undefined): boolean {
  if (proposal === undefined) return false;
  const parsed = captureProposalSchema.safeParse(proposal);
  return parsed.success && parsed.data.memory.scope.kind === 'unresolved_projects';
}
