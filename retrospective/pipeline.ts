import { POLICY_VERSION } from '../src/policy/index.js';
import type { MementoPaths } from '../src/config.js';
import { analyzeTask } from './analyze.js';
import { persistAnalysisResult } from './compare.js';
import { stableId } from './db/id.js';
import type { RetrospectiveStore } from './db/store.js';
import type { EvaluatorIdentity, RunStatus } from './db/types.js';
import type { HistorySource } from './discover.js';
import { CAPTURE_PROMPT_VERSION, SEARCH_PROMPT_VERSION } from './evaluator/passes.js';
import { CHECKPOINT_PROMPT_VERSION } from './checkpoints.js';
import { EVALUATOR_SCHEMA_VERSION } from './evaluator/schema.js';
import type { Evaluator, EvaluatorRuntimeIdentity } from './evaluator/types.js';
import { ingestHistorySources } from './ingest.js';
import type { JsonValue, NormalizedSession } from './model.js';
import { resolveSessionProjects } from './projects.js';
import { reconcileTelemetry, type TelemetryEvent } from './reconcile.js';
import { boundText, redactText } from './redact.js';
import { splitTasks } from './tasks.js';

export const RETROSPECTIVE_PIPELINE_VERSION = '1.4.0' as const;
export const EVALUATION_SUITE_VERSION = `checkpoints-${CHECKPOINT_PROMPT_VERSION}/search-${SEARCH_PROMPT_VERSION}/capture-${CAPTURE_PROMPT_VERSION}`;

export interface RunRetrospectiveOptions {
  store: RetrospectiveStore;
  paths: MementoPaths;
  sources: HistorySource[];
  telemetryEvents: TelemetryEvent[];
  evaluator: Evaluator;
  maxTasks: number;
  sourcePolicyVersion?: string;
  runSalt?: string;
}

export interface RunRetrospectiveResult {
  runId: string;
  status: RunStatus;
  sessionCount: number;
  selectedTaskCount: number;
  analyzedTaskCount: number;
  failedTaskCount: number;
  resumedTaskCount: number;
  quarantinedSourceCount: number;
  warningCount: number;
  reusedCompletedRun: boolean;
}

export async function runRetrospective(
  options: RunRetrospectiveOptions,
): Promise<RunRetrospectiveResult> {
  assertOptions(options);

  // Resolve the local evaluator binary before deriving the run id. A CLI
  // upgrade must create a new run rather than mixing outputs on resume.
  const runtimeEvaluatorIdentity = await options.evaluator.identity();
  assertConfiguredEvaluatorIdentity(options.evaluator, runtimeEvaluatorIdentity);

  const ingestion = await ingestHistorySources({ sources: options.sources });
  if (ingestion.sessions.length === 0) {
    const detail = ingestion.quarantined.map((source) => `${source.sourceId}: ${source.reason}`);
    throw new Error(
      ['No analyzable sessions were ingested.', ...detail].join('\n').slice(0, 4_000),
    );
  }

  const reconciled = reconcileTelemetry(ingestion.sessions, options.telemetryEvents);
  const withPolicy = applyPolicyOverride(reconciled.sessions, options.sourcePolicyVersion);
  const projectResolution = await resolveSessionProjects(
    withPolicy,
    ingestion.projectResolutionHints,
    options.paths.projects,
  );
  const sessions = projectResolution.sessions;
  const tasks = sessions.flatMap(splitTasks).slice(0, options.maxTasks);
  const sourcePolicyVersion = aggregatePolicyVersion(sessions);
  const evaluatorIdentity = suiteEvaluatorIdentity(runtimeEvaluatorIdentity);
  const runId = stableId(
    'run',
    RETROSPECTIVE_PIPELINE_VERSION,
    sourcePolicyVersion,
    evaluatorIdentity as unknown as JsonValue,
    ingestion.sources.map((source) => ({
      sourceId: source.sourceId,
      contentSha256: source.contentSha256,
    })),
    projectResolution.resolutions as unknown as JsonValue,
    reconciliationIdentity(sessions, reconciled),
    options.maxTasks,
    options.runSalt ?? null,
  );

  const metadata = {
    databaseSchemaVersion: options.store.schemaVersion(),
    normalizedSchemaVersion: sessions[0]?.schemaVersion ?? null,
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    currentPolicyVersion: POLICY_VERSION,
    requestedSourcePolicyVersion: options.sourcePolicyVersion ?? null,
    sourceFingerprints: ingestion.sources.map((source) => ({
      sourceId: source.sourceId,
      client: source.client,
      contentSha256: source.contentSha256,
    })),
    projectResolutions: projectResolution.resolutions,
    ingestionWarnings: ingestion.warnings,
    quarantinedSources: ingestion.quarantined,
    reconciliation: {
      matches: reconciled.matches.length,
      ambiguous: reconciled.ambiguous.length,
      unmatchedOperations: reconciled.unmatchedOperationIds.length,
    },
    selectedTaskCount: tasks.length,
    maxTasks: options.maxTasks,
    runSalt: options.runSalt ?? null,
    modelIdentity: {
      requested: runtimeEvaluatorIdentity.model,
      providerResolved: null,
      resolution: 'requested_cli_argument',
    },
  } as unknown as JsonValue;

  const existing = options.store.getRun(runId);
  if (existing && existing.status !== 'ingested') {
    return result(
      runId,
      existing.status,
      sessions,
      tasks.length,
      0,
      options.store.listTaskFailures(runId).length,
      tasks.length,
      ingestion,
      true,
    );
  }

  options.store.createRun({
    id: runId,
    sourcePolicyVersion,
    pipelineVersion: RETROSPECTIVE_PIPELINE_VERSION,
    evaluator: evaluatorIdentity,
    metadata,
  });
  options.store.ingestSourceReferences(runId, ingestion.sources);
  for (const session of sessions) options.store.ingestSession(runId, session);

  let analyzedTaskCount = 0;
  let failedTaskCount = 0;
  let resumedTaskCount = 0;
  for (const task of tasks) {
    if (options.store.hasTaskOutcome(runId, task.id)) {
      resumedTaskCount += 1;
      continue;
    }
    let analysis;
    try {
      analysis = await analyzeTask(task, options.evaluator);
      assertAnalysisEvaluatorIdentity(analysis, runtimeEvaluatorIdentity);
    } catch (error) {
      options.store.recordTaskFailure({
        runId,
        id: task.id,
        sessionId: task.sessionId,
        ordinal: task.index,
        startSequence: task.startSequence,
        endSequence: task.endSequence,
        error: safeTaskFailure(error),
      });
      failedTaskCount += 1;
      continue;
    }
    persistAnalysisResult(options.store, runId, task, analysis);
    analyzedTaskCount += 1;
  }

  const status: RunStatus =
    options.store.listReviewQueue(runId, true).length === 0 ? 'complete' : 'evaluated';
  options.store.setRunStatus(runId, status);
  return result(
    runId,
    status,
    sessions,
    tasks.length,
    analyzedTaskCount,
    failedTaskCount,
    resumedTaskCount,
    ingestion,
    false,
  );
}

function suiteEvaluatorIdentity(evaluator: EvaluatorRuntimeIdentity): EvaluatorIdentity {
  return {
    provider: evaluator.provider,
    cli: evaluator.cli,
    cliVersion: evaluator.cliVersion,
    model: evaluator.model,
    promptVersion: EVALUATION_SUITE_VERSION,
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
  };
}

function assertConfiguredEvaluatorIdentity(
  evaluator: Evaluator,
  identity: EvaluatorRuntimeIdentity,
): void {
  const expectedCli = identity.provider === 'claude-code' ? 'claude' : 'codex';
  if (
    identity.provider !== evaluator.provider ||
    identity.model !== evaluator.model ||
    identity.cli !== expectedCli ||
    identity.cliVersion.trim() === '' ||
    identity.model.trim() === ''
  ) {
    throw new Error('Evaluator preflight identity does not match the configured evaluator.');
  }
}

function assertAnalysisEvaluatorIdentity(
  analysis: Awaited<ReturnType<typeof analyzeTask>>,
  expected: EvaluatorRuntimeIdentity,
): void {
  const runs = [
    analysis.checkpointPlan.evaluator,
    ...analysis.searchEvaluations.map((evaluation) => evaluation.evaluator),
    analysis.captureEvaluation.evaluator,
  ];
  for (const run of runs) {
    if (
      run.provider !== expected.provider ||
      run.cli !== expected.cli ||
      run.cliVersion !== expected.cliVersion ||
      run.model !== expected.model
    ) {
      throw new Error(
        `Evaluator identity changed during the run: expected ${expected.provider}/` +
          `${expected.cli}@${expected.cliVersion}/${expected.model}.`,
      );
    }
  }
}

function safeTaskFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = redactText(message);
  return redacted.ok
    ? boundText(redacted.value)
    : 'Task analysis failed; diagnostic withheld because it could not be safely redacted.';
}

function applyPolicyOverride(
  sessions: NormalizedSession[],
  policyVersion: string | undefined,
): NormalizedSession[] {
  const override = policyVersion?.trim();
  if (!override || override === 'unknown') return sessions;
  return sessions.map((session) =>
    session.policyVersion === 'unknown' ? { ...session, policyVersion: override } : session,
  );
}

function aggregatePolicyVersion(sessions: readonly NormalizedSession[]): string {
  const versions = [...new Set(sessions.map((session) => session.policyVersion))].sort();
  return versions.length === 1 ? versions[0]! : `mixed:${versions.join(',')}`;
}

function reconciliationIdentity(
  sessions: readonly NormalizedSession[],
  reconciled: ReturnType<typeof reconcileTelemetry>,
): JsonValue {
  return {
    matches: sessions
      .flatMap((session) => session.actualOperations)
      .flatMap((operation) =>
        operation.telemetry === undefined
          ? []
          : [{ operationId: operation.id, telemetry: operation.telemetry }],
      ) as unknown as JsonValue,
    ambiguous: reconciled.ambiguous as unknown as JsonValue,
    unmatchedOperationIds: reconciled.unmatchedOperationIds,
  };
}

function assertOptions(options: RunRetrospectiveOptions): void {
  if (options.sources.length === 0) {
    throw new Error('At least one explicit history source is required.');
  }
  if (!Number.isSafeInteger(options.maxTasks) || options.maxTasks < 1) {
    throw new Error('maxTasks must be a positive safe integer.');
  }
  if (options.sourcePolicyVersion !== undefined && options.sourcePolicyVersion.trim() === '') {
    throw new Error('sourcePolicyVersion cannot be blank.');
  }
}

function result(
  runId: string,
  status: RunStatus,
  sessions: readonly NormalizedSession[],
  selectedTaskCount: number,
  analyzedTaskCount: number,
  failedTaskCount: number,
  resumedTaskCount: number,
  ingestion: { quarantined: unknown[]; warnings: unknown[] },
  reusedCompletedRun: boolean,
): RunRetrospectiveResult {
  return {
    runId,
    status,
    sessionCount: sessions.length,
    selectedTaskCount,
    analyzedTaskCount,
    failedTaskCount,
    resumedTaskCount,
    quarantinedSourceCount: ingestion.quarantined.length,
    warningCount:
      ingestion.warnings.length +
      sessions.reduce((sum, session) => sum + session.warnings.length, 0),
    reusedCompletedRun,
  };
}
