import { planCheckpoints } from './checkpoints.js';
import { compareOperations as defaultCompareOperations } from './compare.js';
import { evaluateCaptureTask, evaluateSearchCheckpoint } from './evaluator/passes.js';
import {
  EVALUATOR_SCHEMA_VERSION,
  analysisResultSchema,
  type AnalysisResult,
  type CaptureEvaluation,
  type OperationComparison,
  type SearchEvaluation,
} from './evaluator/schema.js';
import type { Evaluator } from './evaluator/types.js';
import type { NormalizedSession } from './model.js';
import { redactJson } from './redact.js';
import { splitTasks, type NormalizedTask } from './tasks.js';

export type CompareTaskOperations = (
  task: NormalizedTask,
  searchEvaluations: SearchEvaluation[],
  captureEvaluation: CaptureEvaluation,
) => OperationComparison[] | Promise<OperationComparison[]>;

export async function analyzeTask(
  task: NormalizedTask,
  evaluator: Evaluator,
  compareOperations: CompareTaskOperations = defaultCompareOperations,
): Promise<AnalysisResult> {
  const checkpointPlan = await planCheckpoints(task, evaluator);
  const searchEvaluations = await Promise.all(
    checkpointPlan.checkpoints.map((checkpoint) =>
      evaluateSearchCheckpoint(task, checkpoint, evaluator),
    ),
  );
  const captureEvaluation = await evaluateCaptureTask(task, evaluator);
  const comparisons = await compareOperations(task, searchEvaluations, captureEvaluation);

  const analysis = analysisResultSchema.parse({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    taskId: task.id,
    checkpointPlan,
    searchEvaluations,
    captureEvaluation,
    comparisons,
  });
  const redacted = redactJson(analysis);
  if (!redacted.ok) {
    throw new Error(`Evaluator output failed redaction: ${redacted.reason}`);
  }
  return analysisResultSchema.parse(redacted.value);
}

export async function analyzeSession(
  session: NormalizedSession,
  evaluator: Evaluator,
  compareOperations: CompareTaskOperations = defaultCompareOperations,
): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = [];
  for (const task of splitTasks(session)) {
    results.push(await analyzeTask(task, evaluator, compareOperations));
  }
  return results;
}
