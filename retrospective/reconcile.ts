import type {
  ActualMemoryOperation,
  HistoryClient,
  NormalizedSession,
  ReconciledTelemetry,
} from './model.js';
import { canonicalMementoTool } from './adapters/common.js';

export interface TelemetryEvent {
  event_id: string;
  timestamp: string;
  tool: string;
  outcome?: 'success' | 'error';
  session_id?: string;
  server_version?: string;
  policy_version?: string;
  variant?: string;
  client_name?: string;
  client_version?: string;
  log_schema_version?: number;
  result_outcome?: string;
  memory_id?: string;
  result_ids?: string[];
  candidate_ids?: string[];
  project_ids?: string[];
}

export interface ReconciliationOptions {
  maxClockSkewMs?: number;
}

export interface ReconciliationMatch {
  operationId: string;
  telemetryEventId: string;
}

export interface AmbiguousReconciliation {
  operationId: string;
  candidateTelemetryEventIds: string[];
}

export interface ReconciliationResult {
  sessions: NormalizedSession[];
  matches: ReconciliationMatch[];
  ambiguous: AmbiguousReconciliation[];
  unmatchedOperationIds: string[];
  unmatchedTelemetryEventIds: string[];
}

interface Candidate {
  event: TelemetryEvent;
  hasIdentityEvidence: boolean;
}

export function reconcileTelemetry(
  sessions: NormalizedSession[],
  telemetryEvents: TelemetryEvent[],
  options: ReconciliationOptions = {},
): ReconciliationResult {
  const maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
  const copies = sessions.map(copySession);
  const operations = copies.flatMap((session) =>
    session.actualOperations.map((operation) => ({ session, operation })),
  );
  const candidatesByOperation = new Map<string, Candidate[]>();
  const identifiedOperationIdsByEvent = new Map<string, Set<string>>();

  for (const { session, operation } of operations) {
    const candidates = telemetryEvents
      .filter((event) => compatible(session.client, operation, event, maxClockSkewMs))
      .map((event) => ({ event, hasIdentityEvidence: hasIdentityEvidence(operation, event) }))
      .sort((left, right) => left.event.event_id.localeCompare(right.event.event_id));
    candidatesByOperation.set(operation.id, candidates);
    for (const candidate of candidates) {
      if (!candidate.hasIdentityEvidence) continue;
      const operationIds =
        identifiedOperationIdsByEvent.get(candidate.event.event_id) ?? new Set<string>();
      operationIds.add(operation.id);
      identifiedOperationIdsByEvent.set(candidate.event.event_id, operationIds);
    }
  }

  const matches: ReconciliationMatch[] = [];
  const ambiguous: AmbiguousReconciliation[] = [];
  const usedTelemetry = new Set<string>();
  for (const { operation } of operations.sort((left, right) =>
    left.operation.id.localeCompare(right.operation.id),
  )) {
    const candidates = candidatesByOperation.get(operation.id) ?? [];
    const unused = candidates.filter((candidate) => !usedTelemetry.has(candidate.event.event_id));
    const identityMatches = unused.filter((candidate) => candidate.hasIdentityEvidence);
    const selected =
      identityMatches.length === 1 &&
      (identifiedOperationIdsByEvent.get(identityMatches[0]!.event.event_id)?.size ?? 0) === 1
        ? identityMatches[0]
        : undefined;

    if (selected) {
      operation.telemetry = toReconciledTelemetry(selected.event);
      if (operation.outcome === 'unknown' && selected.event.outcome !== undefined) {
        operation.outcome = selected.event.outcome;
      }
      usedTelemetry.add(selected.event.event_id);
      matches.push({ operationId: operation.id, telemetryEventId: selected.event.event_id });
    } else {
      const ambiguousCandidates = identityMatches.length > 0 ? identityMatches : unused;
      if (ambiguousCandidates.length < 2 && identityMatches.length === 0) continue;
      ambiguous.push({
        operationId: operation.id,
        candidateTelemetryEventIds: ambiguousCandidates
          .map((candidate) => candidate.event.event_id)
          .sort(),
      });
    }
  }

  for (const session of copies) applyPolicyVersion(session);
  const matchedOperationIds = new Set(matches.map((match) => match.operationId));
  return {
    sessions: copies,
    matches,
    ambiguous,
    unmatchedOperationIds: operations
      .map(({ operation }) => operation.id)
      .filter((id) => !matchedOperationIds.has(id))
      .sort(),
    unmatchedTelemetryEventIds: telemetryEvents
      .map((event) => event.event_id)
      .filter((id) => !usedTelemetry.has(id))
      .sort(),
  };
}

function compatible(
  client: HistoryClient,
  operation: ActualMemoryOperation,
  event: TelemetryEvent,
  maxClockSkewMs: number,
): boolean {
  const eventTool = canonicalMementoTool(event.tool, 'memento');
  if (!eventTool || eventTool !== operation.tool) return false;
  if (!compatibleClient(client, event.client_name)) return false;
  if (!operation.timestamp) return false;
  const operationTime = Date.parse(operation.timestamp);
  const eventTime = Date.parse(event.timestamp);
  if (!Number.isFinite(operationTime) || !Number.isFinite(eventTime)) return false;
  if (Math.abs(operationTime - eventTime) > maxClockSkewMs) return false;
  if (operation.outcome !== 'unknown' && event.outcome && operation.outcome !== event.outcome) {
    return false;
  }

  const operationProjects = operation.scope?.projectIds;
  if (
    operationProjects?.length &&
    event.project_ids?.length &&
    !sameSet(operationProjects, event.project_ids)
  ) {
    return false;
  }
  const operationIds = operationMemoryIds(operation);
  const eventMemoryIds = eventIds(event);
  if (
    operationIds.length &&
    eventMemoryIds.length &&
    !operationIds.some((id) => eventMemoryIds.includes(id))
  ) {
    return false;
  }
  return true;
}

function hasIdentityEvidence(operation: ActualMemoryOperation, event: TelemetryEvent): boolean {
  // Telemetry session_id identifies a server process, not the source conversation.
  const telemetryMemoryIds = eventIds(event);
  const memoryIds = operationMemoryIds(operation);
  if (memoryIds.some((id) => telemetryMemoryIds.includes(id))) return true;

  const operationProjects = operation.scope?.projectIds;
  return Boolean(
    operationProjects?.length &&
    event.project_ids?.length &&
    sameSet(operationProjects, event.project_ids),
  );
}

function operationMemoryIds(operation: ActualMemoryOperation): string[] {
  const inputId =
    operation.input !== undefined &&
    operation.input !== null &&
    typeof operation.input === 'object' &&
    !Array.isArray(operation.input) &&
    typeof operation.input.id === 'string'
      ? operation.input.id
      : undefined;
  return [...new Set([...(operation.memoryIds ?? []), ...(inputId ? [inputId] : [])])];
}

function eventIds(event: TelemetryEvent): string[] {
  return [event.memory_id, ...(event.result_ids ?? []), ...(event.candidate_ids ?? [])].filter(
    (id): id is string => typeof id === 'string',
  );
}

function compatibleClient(client: HistoryClient, clientName: string | undefined): boolean {
  if (!clientName) return true;
  const normalized = clientName.toLowerCase();
  const declared = normalized.includes('claude')
    ? 'claude-code'
    : normalized.includes('codex')
      ? 'codex'
      : undefined;
  return declared === undefined || declared === client;
}

function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((item, index) => item === [...right].sort()[index])
  );
}

function toReconciledTelemetry(event: TelemetryEvent): ReconciledTelemetry {
  return {
    eventId: event.event_id,
    timestamp: event.timestamp,
    ...(event.policy_version ? { policyVersion: event.policy_version } : {}),
    ...(event.server_version ? { serverVersion: event.server_version } : {}),
    ...(event.variant ? { variant: event.variant } : {}),
    ...(event.session_id ? { sessionId: event.session_id } : {}),
    ...(event.client_version ? { clientVersion: event.client_version } : {}),
    ...(event.log_schema_version === undefined
      ? {}
      : { logSchemaVersion: event.log_schema_version }),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.result_outcome ? { resultOutcome: event.result_outcome } : {}),
    ...(event.result_ids ? { resultIds: [...event.result_ids] } : {}),
    ...(event.candidate_ids ? { candidateIds: [...event.candidate_ids] } : {}),
    ...(event.memory_id ? { memoryId: event.memory_id } : {}),
    ...(event.project_ids ? { projectIds: [...event.project_ids] } : {}),
  };
}

function applyPolicyVersion(session: NormalizedSession): void {
  if (session.actualOperations.length === 0) return;
  const versions = new Set(
    session.actualOperations.map((operation) => operation.telemetry?.policyVersion),
  );
  if (versions.has(undefined)) return;
  if (versions.size === 1) session.policyVersion = [...versions][0] ?? 'unknown';
}

function copySession(session: NormalizedSession): NormalizedSession {
  return {
    ...session,
    threads: session.threads.map((thread) => ({ ...thread })),
    events: session.events.map((event) => ({
      ...event,
      ...(event.toolCall ? { toolCall: { ...event.toolCall } } : {}),
    })),
    actualOperations: session.actualOperations.map((operation) => ({ ...operation })),
    warnings: [...session.warnings],
  };
}
