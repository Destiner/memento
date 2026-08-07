import type { RetrospectiveStore } from './db/store.js';
import type {
  ComparisonKind,
  ComparisonLabel,
  PromotionStatus,
  ReviewState,
  RunRecord,
} from './db/types.js';
import { isPromotionEligible } from './promote.js';

export interface ReviewedReport {
  run: RunRecord;
  taskFailures: number;
  reviewed: number;
  unreviewedExcluded: number;
  byKind: Record<ComparisonKind, number>;
  byLabel: Partial<Record<ComparisonLabel, number>>;
  byDecision: Record<Exclude<ReviewState, 'pending'>, number>;
  activation: {
    eligibleSessions: number;
    activatedSessions: number;
    rate: number | null;
  };
  capture: {
    eligibleProposals: number;
    capturedProposals: number;
    rate: number | null;
  };
  promotion: {
    approvedWrites: number;
    notAttempted: number;
    byStatus: Partial<Record<Exclude<PromotionStatus, 'started'> | 'started', number>>;
  };
}

export function buildReviewedReport(store: RetrospectiveStore, runId: string): ReviewedReport {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`Unknown retrospective run: ${runId}`);
  // One row per opportunity: a collapsed duplicate would otherwise contribute
  // to the label totals and to every rate derived from them.
  const all = store
    .listReviewQueue(runId, true)
    .filter((item) => item.duplicateOfComparisonId === undefined);
  const reviewed = all.filter((item) => item.state !== 'pending');
  const acceptedProposals = reviewed.filter(
    (item) => item.state === 'approved' && item.proposalId !== undefined,
  );
  const facts = new Map(
    store
      .query<ComparisonFact>(
        `SELECT c.id, t.session_id
         FROM comparisons c
         JOIN tasks t ON t.run_id = c.run_id AND t.id = c.task_id
         WHERE c.run_id = ?`,
        runId,
      )
      .map((fact) => [fact.id, fact]),
  );
  const eligibleSearches = acceptedProposals.filter((item) => item.kind === 'search');
  const eligibleSessionIds = new Set(
    eligibleSearches.flatMap((item) => {
      const sessionId = facts.get(item.id)?.session_id;
      return sessionId === undefined ? [] : [sessionId];
    }),
  );
  const activatedSessionIds = new Set(
    eligibleSearches.flatMap((item) => {
      const fact = facts.get(item.id);
      return fact !== undefined &&
        item.actualOperationId !== undefined &&
        actualOutcome(item.actualOperation) === 'success' &&
        item.label !== 'attempted_not_stored' &&
        item.label !== 'transcript_only'
        ? [fact.session_id]
        : [];
    }),
  );
  const eligibleCaptures = acceptedProposals.filter((item) => item.kind === 'write');
  const captured = eligibleCaptures.filter((item) => {
    return (
      item.actualOperationId !== undefined &&
      actualOutcome(item.actualOperation) === 'success' &&
      item.label !== 'attempted_not_stored' &&
      item.label !== 'transcript_only'
    );
  });
  const approvedWrites = reviewed.filter(isPromotionEligible);
  const latestPromotions = approvedWrites
    .map((item) => store.latestPromotion(item.id))
    .filter((attempt) => attempt !== undefined);

  return {
    run,
    taskFailures: store.listTaskFailures(runId).length,
    reviewed: reviewed.length,
    unreviewedExcluded: all.length - reviewed.length,
    byKind: {
      search: reviewed.filter((item) => item.kind === 'search').length,
      write: reviewed.filter((item) => item.kind === 'write').length,
    },
    byLabel: countBy(reviewed.map((item) => item.label)),
    byDecision: {
      approved: reviewed.filter((item) => item.state === 'approved').length,
      rejected: reviewed.filter((item) => item.state === 'rejected').length,
      duplicate: reviewed.filter((item) => item.state === 'duplicate').length,
    },
    activation: {
      eligibleSessions: eligibleSessionIds.size,
      activatedSessions: activatedSessionIds.size,
      rate: ratio(activatedSessionIds.size, eligibleSessionIds.size),
    },
    capture: {
      eligibleProposals: eligibleCaptures.length,
      capturedProposals: captured.length,
      rate: ratio(captured.length, eligibleCaptures.length),
    },
    promotion: {
      approvedWrites: approvedWrites.length,
      notAttempted: approvedWrites.length - latestPromotions.length,
      byStatus: countBy(latestPromotions.map((attempt) => attempt.status)),
    },
  };
}

export function renderReviewedReport(report: ReviewedReport): string {
  const labels = Object.entries(report.byLabel)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `- ${label}: ${count}`);
  const promotions = Object.entries(report.promotion.byStatus)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `- ${status}: ${count}`);
  return [
    `Retrospective run ${report.run.id}`,
    `Policy: ${report.run.sourcePolicyVersion}; pipeline: ${report.run.pipelineVersion}`,
    `Task analysis failures: ${report.taskFailures}`,
    `Reviewed ground truth: ${report.reviewed} (${report.unreviewedExcluded} pending excluded)`,
    `Search items: ${report.byKind.search}; write items: ${report.byKind.write}`,
    `Decisions: ${report.byDecision.approved} approved, ${report.byDecision.rejected} rejected, ` +
      `${report.byDecision.duplicate} duplicate`,
    `Search activation: ${report.activation.activatedSessions}/${report.activation.eligibleSessions} ` +
      `eligible sessions (${formatRate(report.activation.rate)})`,
    `Learning capture: ${report.capture.capturedProposals}/${report.capture.eligibleProposals} ` +
      `eligible proposals (${formatRate(report.capture.rate)})`,
    '',
    'Labels:',
    ...(labels.length === 0 ? ['- none'] : labels),
    '',
    `Approved writes: ${report.promotion.approvedWrites}; not attempted: ${report.promotion.notAttempted}`,
    'Promotion outcomes:',
    ...(promotions.length === 0 ? ['- none'] : promotions),
  ].join('\n');
}

interface ComparisonFact {
  id: string;
  session_id: string;
}

function actualOutcome(value: unknown): 'unknown' | 'success' | 'error' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outcome = (value as Record<string, unknown>).outcome;
  return outcome === 'unknown' || outcome === 'success' || outcome === 'error'
    ? outcome
    : undefined;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
