import type { JsonValue, ActualMemoryOperation, OperationScope } from './model.js';
import type { NormalizedTask } from './tasks.js';
import { evaluationEvents } from './evaluator/context.js';
import type { RetrospectiveStore } from './db/store.js';
import type { EvaluatorIdentity } from './db/types.js';
import type {
  AnalysisResult,
  CaptureEvaluation,
  CaptureProposal,
  OperationComparison,
  SearchEvaluation,
  SearchProposal,
} from './evaluator/schema.js';

interface SearchCandidate {
  proposal: SearchProposal;
  proposalIndex: number;
  timelyThroughSequence: number;
}

interface CaptureCandidate {
  proposal: CaptureProposal;
  proposalIndex: number;
}

interface Pair<T> {
  proposal: T;
  actual: ActualMemoryOperation;
  score: number;
  scope: 'same' | 'different' | 'unknown';
  textScore: number;
}

export function compareOperations(
  task: NormalizedTask,
  searchEvaluations: SearchEvaluation[],
  captureEvaluation: CaptureEvaluation,
): OperationComparison[] {
  return [...compareSearches(task, searchEvaluations), ...compareCaptures(task, captureEvaluation)];
}

// A checkpoint is an observed event, so an agent can only issue the resulting
// search in a following event. One assistant/tool event plus its paired result is
// the common normalized shape; this small grace avoids calling an immediate
// response "late" while keeping the heuristic deliberately conservative.
export const SEARCH_TIMELY_GRACE_EVENTS = 2;

export function persistAnalysisResult(
  store: RetrospectiveStore,
  runId: string,
  task: NormalizedTask,
  analysis: AnalysisResult,
): void {
  store.withTransaction(() => {
    store.insertTask({
      runId,
      id: task.id,
      sessionId: task.sessionId,
      ordinal: task.index,
      startSequence: task.startSequence,
      endSequence: task.endSequence,
      summary: analysis.captureEvaluation.summary,
      context: asJson({
        projectContext: task.projectContext ?? null,
        events: evaluationEvents(task, 'capture'),
      }),
    });

    for (const [ordinal, checkpoint] of analysis.checkpointPlan.checkpoints.entries()) {
      store.insertCheckpoint({
        runId,
        id: checkpoint.id,
        taskId: task.id,
        ordinal,
        afterSequence: checkpoint.sequence,
        reason: checkpoint.reason,
        context: asJson({
          projectContext: task.projectContext ?? null,
          events: evaluationEvents(task, 'search', checkpoint.sequence),
        }),
      });
    }

    const searchProposalIds: string[] = [];
    for (const evaluation of analysis.searchEvaluations) {
      for (const proposal of evaluation.proposals) {
        searchProposalIds.push(
          store.insertProposal({
            runId,
            taskId: task.id,
            checkpointId: evaluation.checkpoint.id,
            ordinal: searchProposalIds.length,
            kind: 'search',
            payload: asJson(proposal),
            rationale: proposal.rationale,
            evaluator: evaluatorIdentity(evaluation.evaluator),
          }),
        );
      }
    }

    const captureProposalIds = analysis.captureEvaluation.proposals.map((proposal, ordinal) =>
      store.insertProposal({
        runId,
        taskId: task.id,
        ordinal,
        kind: proposal.action,
        payload: asJson(proposal),
        rationale: proposal.rationale,
        evaluator: evaluatorIdentity(analysis.captureEvaluation.evaluator),
      }),
    );

    for (const comparison of analysis.comparisons) {
      const ids = comparison.kind === 'search' ? searchProposalIds : captureProposalIds;
      const proposalId =
        comparison.proposalIndex === null ? undefined : ids[comparison.proposalIndex];
      if (comparison.proposalIndex !== null && proposalId === undefined) {
        throw new Error(
          `Comparison references missing ${comparison.kind} proposal ${comparison.proposalIndex}.`,
        );
      }
      store.insertComparison({
        runId,
        taskId: task.id,
        kind: comparison.kind === 'search' ? 'search' : 'write',
        ...(proposalId === undefined ? {} : { proposalId }),
        ...(comparison.actualOperationIds[0] === undefined
          ? {}
          : { actualOperationId: comparison.actualOperationIds[0] }),
        label: comparison.classification,
        explanation: comparison.explanation,
      });
    }
  });
}

function compareSearches(
  task: NormalizedTask,
  evaluations: SearchEvaluation[],
): OperationComparison[] {
  const proposals: SearchCandidate[] = [];
  for (const evaluation of evaluations) {
    for (const proposal of evaluation.proposals) {
      proposals.push({
        proposal,
        proposalIndex: proposals.length,
        timelyThroughSequence: evaluation.checkpoint.sequence + SEARCH_TIMELY_GRACE_EVENTS,
      });
    }
  }
  const actual = task.actualOperations.filter((operation) => operation.kind === 'search');
  const pairs = matchOneToOne(proposals, actual, scoreSearch);
  const matchedProposals = new Set(pairs.map((pair) => pair.proposal.proposalIndex));
  const matchedActual = new Set(pairs.map((pair) => pair.actual.id));
  const comparisons: OperationComparison[] = pairs.map((pair) => ({
    kind: 'search',
    proposalIndex: pair.proposal.proposalIndex,
    actualOperationIds: [pair.actual.id],
    classification: classifySearch(pair),
    explanation: explainSearch(pair),
  }));

  for (const proposal of proposals) {
    if (matchedProposals.has(proposal.proposalIndex)) continue;
    comparisons.push({
      kind: 'search',
      proposalIndex: proposal.proposalIndex,
      actualOperationIds: [],
      classification: 'missed',
      explanation: 'No actual search matched this checkpoint proposal.',
    });
  }
  for (const operation of actual) {
    if (matchedActual.has(operation.id)) continue;
    comparisons.push(unmatchedActual('search', operation));
  }
  return comparisons;
}

function compareCaptures(
  task: NormalizedTask,
  evaluation: CaptureEvaluation,
): OperationComparison[] {
  const proposals = evaluation.proposals.map((proposal, proposalIndex) => ({
    proposal,
    proposalIndex,
  }));
  const actual = task.actualOperations.filter((operation) => operation.kind === 'write');
  const pairs = matchOneToOne(proposals, actual, scoreCapture);
  const matchedProposals = new Set(pairs.map((pair) => pair.proposal.proposalIndex));
  const matchedActual = new Set(pairs.map((pair) => pair.actual.id));
  const comparisons: OperationComparison[] = pairs.map((pair) => ({
    kind: 'capture',
    proposalIndex: pair.proposal.proposalIndex,
    actualOperationIds: [pair.actual.id],
    classification: classifyCapture(pair),
    explanation: explainCapture(pair),
  }));

  for (const proposal of proposals) {
    if (matchedProposals.has(proposal.proposalIndex)) continue;
    comparisons.push({
      kind: 'capture',
      proposalIndex: proposal.proposalIndex,
      actualOperationIds: [],
      classification: 'missed',
      explanation: 'No actual memory write matched this capture proposal.',
    });
  }
  for (const operation of actual) {
    if (matchedActual.has(operation.id)) continue;
    comparisons.push(unmatchedActual('capture', operation));
  }
  return comparisons;
}

function matchOneToOne<T>(
  proposals: T[],
  actual: ActualMemoryOperation[],
  score: (proposal: T, operation: ActualMemoryOperation) => Pair<T> | undefined,
): Pair<T>[] {
  const candidates = proposals.flatMap((proposal) =>
    actual.flatMap((operation) => {
      const candidate = score(proposal, operation);
      return candidate === undefined ? [] : [candidate];
    }),
  );
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.actual.sequence - right.actual.sequence ||
      left.actual.id.localeCompare(right.actual.id),
  );

  const usedProposals = new Set<T>();
  const usedActual = new Set<string>();
  const matches: Pair<T>[] = [];
  for (const candidate of candidates) {
    if (usedProposals.has(candidate.proposal) || usedActual.has(candidate.actual.id)) continue;
    usedProposals.add(candidate.proposal);
    usedActual.add(candidate.actual.id);
    matches.push(candidate);
  }
  return matches;
}

function scoreSearch(
  candidate: SearchCandidate,
  actual: ActualMemoryOperation,
): Pair<SearchCandidate> | undefined {
  const query = stringField(actual.input, 'query') ?? stringField(actual.input, 'intent') ?? '';
  const textScore = similarity(candidate.proposal.search.query, query);
  const scope = scopeRelation(candidate.proposal.search.scope, actual.scope);
  if (textScore < 0.2) return undefined;
  return {
    proposal: candidate,
    actual,
    textScore,
    scope,
    score: textScore + (scope === 'same' ? 0.3 : scope === 'unknown' ? 0.05 : 0),
  };
}

function scoreCapture(
  candidate: CaptureCandidate,
  actual: ActualMemoryOperation,
): Pair<CaptureCandidate> | undefined {
  const expectedTool = candidate.proposal.action === 'create' ? 'create_memory' : 'update_memory';
  const actionScore = actual.tool === expectedTool ? 0.35 : 0;
  const inputText = [
    stringField(actual.input, 'title'),
    stringField(actual.input, 'description'),
    nestedStringField(actual.input, 'changes', 'title'),
    nestedStringField(actual.input, 'changes', 'description'),
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
  const proposedText = `${candidate.proposal.memory.title} ${candidate.proposal.memory.description}`;
  const textScore = similarity(proposedText, inputText);
  const scope = scopeRelation(
    candidate.proposal.memory.scope,
    actual.scope ??
      (actual.tool === 'update_memory' ? scopeFromOutput(actual.output) : undefined) ??
      scopeFromInput(actual.input),
  );
  const targetScore =
    candidate.proposal.targetMemoryId !== null &&
    candidate.proposal.targetMemoryId === stringField(actual.input, 'id')
      ? 0.4
      : 0;
  if (targetScore === 0 && textScore < 0.2) return undefined;
  const total = textScore + actionScore + targetScore + (scope === 'same' ? 0.2 : 0);
  if (total < 0.35) return undefined;
  return { proposal: candidate, actual, textScore, scope, score: total };
}

function classifySearch(pair: Pair<SearchCandidate>): OperationComparison['classification'] {
  const attempt = attemptClassification(pair.actual);
  if (attempt !== undefined) return attempt;
  if (pair.scope === 'different') return 'incorrect_scope';
  if (pair.textScore < 0.35 || pair.scope === 'unknown') return 'ambiguous';
  return pair.actual.sequence <= pair.proposal.timelyThroughSequence ? 'timely' : 'late';
}

function classifyCapture(pair: Pair<CaptureCandidate>): OperationComparison['classification'] {
  const attempt = attemptClassification(pair.actual);
  if (attempt !== undefined) return attempt;
  if (pair.scope === 'different') return 'incorrect_scope';
  if (pair.scope === 'unknown') return 'ambiguous';
  if (pair.textScore < 0.2 && pair.proposal.proposal.targetMemoryId === null) return 'ambiguous';
  return 'timely';
}

function attemptClassification(
  operation: ActualMemoryOperation,
): 'attempted_not_stored' | 'transcript_only' | undefined {
  if (
    operation.outcome === 'error' ||
    operation.telemetry?.resultOutcome === 'duplicate_candidates' ||
    hasOutputOutcome(operation.output, 'duplicate_candidates')
  ) {
    return 'attempted_not_stored';
  }
  if (
    operation.outcome === 'unknown' &&
    operation.resultEventId === undefined &&
    operation.telemetry === undefined
  ) {
    return 'transcript_only';
  }
  return undefined;
}

function unmatchedActual(
  kind: 'search' | 'capture',
  operation: ActualMemoryOperation,
): OperationComparison {
  const attempted = attemptClassification(operation);
  return {
    kind,
    proposalIndex: null,
    actualOperationIds: [operation.id],
    classification: attempted ?? 'unnecessary_candidate',
    explanation:
      attempted === 'transcript_only'
        ? 'The transcript contains the operation, but no result or telemetry confirms it ran.'
        : attempted === 'attempted_not_stored'
          ? 'The operation was attempted but did not complete successfully.'
          : 'No retrospective proposal matched this actual operation; human review is required.',
  };
}

function explainSearch(pair: Pair<SearchCandidate>): string {
  const classification = classifySearch(pair);
  if (classification === 'timely') {
    return 'A matching search completed within the proposed checkpoint window.';
  }
  if (classification === 'late')
    return 'A matching search occurred only after the proposed checkpoint.';
  if (classification === 'incorrect_scope')
    return 'The query matched, but the actual search used a different scope.';
  if (classification === 'attempted_not_stored') return 'The matching search attempt failed.';
  if (classification === 'transcript_only')
    return 'The matching search appears only in the transcript.';
  return 'The match is weak or lacks enough scope information for an automatic classification.';
}

function explainCapture(pair: Pair<CaptureCandidate>): string {
  const classification = classifyCapture(pair);
  if (classification === 'timely') return 'A matching memory write completed during the task.';
  if (classification === 'incorrect_scope')
    return 'The write content matched, but its scope differed.';
  if (classification === 'attempted_not_stored') {
    return 'The write was attempted but failed or returned duplicate candidates without storing.';
  }
  if (classification === 'transcript_only')
    return 'The matching write appears only in the transcript.';
  return 'The write is only a weak match for this capture proposal.';
}

function scopeRelation(
  proposed:
    | { kind: 'global' }
    | { kind: 'projects'; project_ids: string[]; match?: 'any' | 'all' }
    | { kind: 'unresolved_projects' },
  actual: OperationScope | undefined,
): 'same' | 'different' | 'unknown' {
  if (proposed.kind === 'unresolved_projects') return 'unknown';
  if (actual === undefined || actual.kind === 'unknown') return 'unknown';
  if (proposed.kind !== actual.kind) return 'different';
  if (proposed.kind === 'global') return 'same';
  const proposedIds = [...proposed.project_ids].sort();
  const actualIds = [...(actual.projectIds ?? [])].sort();
  if (proposedIds.length === 0 || actualIds.length === 0) return 'unknown';
  const sameIds =
    proposedIds.length === actualIds.length &&
    proposedIds.every((projectId, index) => projectId === actualIds[index]);
  const sameMatch = (proposed.match ?? 'any') === (actual.match ?? 'any');
  return sameIds && sameMatch ? 'same' : 'different';
}

function scopeFromInput(input: JsonValue | undefined): OperationScope | undefined {
  const record = recordValue(input);
  const changes = recordValue(record?.changes);
  return normalizedScope(recordValue(changes?.scope) ?? recordValue(record?.scope));
}

function scopeFromOutput(output: JsonValue | undefined, depth = 0): OperationScope | undefined {
  if (output === undefined || output === null || depth > 16) return undefined;
  if (Array.isArray(output)) {
    for (const item of output) {
      const scope = scopeFromOutput(item, depth + 1);
      if (scope) return scope;
    }
    return undefined;
  }
  if (typeof output !== 'object') return undefined;
  const memory = recordValue(output.memory);
  if (memory) {
    const scope = normalizedScope(recordValue(memory.scope));
    if (scope) return scope;
  }
  for (const item of Object.values(output)) {
    const scope = scopeFromOutput(item, depth + 1);
    if (scope) return scope;
  }
  return undefined;
}

function normalizedScope(scope: Record<string, JsonValue> | undefined): OperationScope | undefined {
  if (scope === undefined) return undefined;
  if (scope?.kind === 'global') return { kind: 'global' };
  if (scope?.kind !== 'projects') return { kind: 'unknown' };
  const projectIds = Array.isArray(scope.project_ids)
    ? scope.project_ids.filter((value): value is string => typeof value === 'string')
    : undefined;
  const match = scope.match === 'any' || scope.match === 'all' ? scope.match : undefined;
  return {
    kind: 'projects',
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(match === undefined ? {} : { match }),
  };
}

function hasOutputOutcome(output: JsonValue | undefined, expected: string): boolean {
  if (output === undefined || output === null) return false;
  if (Array.isArray(output)) return output.some((value) => hasOutputOutcome(value, expected));
  if (typeof output !== 'object') return false;
  for (const [key, value] of Object.entries(output)) {
    if ((key === 'outcome' || key === 'result_outcome') && value === expected) return true;
    if (hasOutputOutcome(value, expected)) return true;
  }
  return false;
}

function stringField(value: JsonValue | undefined, key: string): string | undefined {
  const field = recordValue(value)?.[key];
  return typeof field === 'string' ? field : undefined;
}

function nestedStringField(
  value: JsonValue | undefined,
  parent: string,
  key: string,
): string | undefined {
  return stringField(recordValue(value)?.[parent], key);
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function similarity(left: string, right: string): number {
  const leftTerms = terms(left);
  const rightTerms = terms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let intersection = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) intersection += 1;
  return (2 * intersection) / (leftTerms.size + rightTerms.size);
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 2),
  );
}

function evaluatorIdentity(evaluator: SearchEvaluation['evaluator']): EvaluatorIdentity {
  return {
    provider: evaluator.provider,
    cli: evaluator.cli,
    cliVersion: evaluator.cliVersion,
    model: evaluator.model,
    promptVersion: evaluator.promptVersion,
    schemaVersion: evaluator.schemaVersion,
    policyVersion: evaluator.policyVersion,
  };
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
