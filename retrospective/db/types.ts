import type { JsonValue } from '../model.js';
import type { TargetMemorySnapshot } from '../memory-snapshot.js';

export type RunStatus = 'ingested' | 'evaluated' | 'reviewing' | 'complete';

export interface EvaluatorIdentity {
  provider: string;
  cli?: string;
  cliVersion?: string;
  model: string;
  promptVersion: string;
  schemaVersion: number | string;
  policyVersion?: string;
}

export interface RunInput {
  id: string;
  sourcePolicyVersion: string;
  pipelineVersion: string;
  status?: RunStatus;
  evaluator?: EvaluatorIdentity;
  metadata?: JsonValue;
}

export interface RunRecord {
  id: string;
  sourcePolicyVersion: string;
  pipelineVersion: string;
  status: RunStatus;
  evaluator?: EvaluatorIdentity;
  metadata: JsonValue;
  createdAt: string;
}

export interface SourceReferenceInput {
  sourceId: string;
  client: 'claude-code' | 'codex';
  path: string;
  contentSha256: string;
}

export interface TaskInput {
  runId: string;
  id: string;
  sessionId: string;
  ordinal: number;
  startSequence: number;
  endSequence: number;
  title?: string;
  summary?: string;
  context?: JsonValue;
}

export interface TaskFailureInput {
  runId: string;
  id: string;
  sessionId: string;
  ordinal: number;
  startSequence: number;
  endSequence: number;
  error: string;
}

export interface TaskFailureRecord extends TaskFailureInput {
  createdAt: string;
}

export interface CheckpointInput {
  runId: string;
  id: string;
  taskId: string;
  ordinal: number;
  afterSequence: number;
  reason: string;
  context: JsonValue;
}

export type ProposalKind = 'search' | 'create' | 'update';

export interface ProposalInput {
  id?: string;
  runId: string;
  taskId: string;
  checkpointId?: string;
  ordinal: number;
  kind: ProposalKind;
  payload: JsonValue;
  rationale?: string;
  evaluator: EvaluatorIdentity;
}

export const COMPARISON_LABELS = [
  'timely',
  'late',
  'missed',
  'unnecessary_candidate',
  'incorrect_scope',
  'ambiguous',
  'transcript_only',
  'attempted_not_stored',
] as const;

export type ComparisonLabel = (typeof COMPARISON_LABELS)[number];
export type ComparisonKind = 'search' | 'write';

export interface ComparisonInput {
  id?: string;
  runId: string;
  taskId: string;
  kind: ComparisonKind;
  proposalId?: string;
  actualOperationId?: string;
  label: ComparisonLabel;
  explanation: string;
}

export type ReviewAction = 'approve' | 'edit' | 'reject' | 'duplicate';
export type ReviewState = 'pending' | 'approved' | 'rejected' | 'duplicate';

export interface ReviewEvent {
  id: string;
  comparisonId: string;
  sequence: number;
  action: ReviewAction;
  reason?: string;
  duplicateTargetMemoryId?: string;
  revision?: JsonValue;
  label?: ComparisonLabel;
  /** Present on edit events; null explicitly detaches the evaluator's original match. */
  actualOperationId?: string | null;
  /** Present on home-aware approve/edit events; null clears an earlier update snapshot. */
  targetMemorySnapshot?: TargetMemorySnapshot | null;
  actor: string;
  createdAt: string;
}

export interface ReviewQueueItem {
  id: string;
  runId: string;
  taskId: string;
  kind: ComparisonKind;
  proposalId?: string;
  actualOperationId?: string;
  originalActualOperationId?: string;
  label: ComparisonLabel;
  originalLabel: ComparisonLabel;
  explanation: string;
  state: ReviewState;
  proposal?: JsonValue;
  revision?: JsonValue;
  taskSummary?: string;
  context?: JsonValue;
  actualOperation?: JsonValue;
  targetMemorySnapshot?: TargetMemorySnapshot;
  reviewEvents: ReviewEvent[];
}

export type ReviewCommand =
  | { action: 'approve'; actor: string }
  | {
      action: 'edit';
      actor: string;
      reason: string;
      revision: JsonValue;
      label: ComparisonLabel;
      actualOperationId: string | null;
    }
  | { action: 'reject'; actor: string; reason: string }
  | { action: 'duplicate'; actor: string; reason: string; targetMemoryId: string };

export type StoredReviewCommand = ReviewCommand & {
  targetMemorySnapshot?: TargetMemorySnapshot | null;
};

export type PromotionStatus =
  'started' | 'succeeded' | 'duplicate_candidates' | 'failed' | 'ambiguous';

export interface PromotionAttempt {
  id: string;
  comparisonId: string;
  attempt: number;
  status: PromotionStatus;
  proposal: JsonValue;
  result?: JsonValue;
  promotedMemoryId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
