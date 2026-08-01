import { SERVER_INSTRUCTIONS } from '../../src/policy/index.js';
import type { NormalizedTask } from '../tasks.js';
import { evaluationEvents } from './context.js';
import {
  evaluatorInstructionHierarchy,
  trustedPolicy,
  untrustedSessionEvidence,
} from './prompt.js';
import {
  EVALUATOR_SCHEMA_VERSION,
  captureEvaluationSchema,
  captureProposalBatchSchema,
  searchEvaluationSchema,
  searchProposalBatchSchema,
  type CaptureEvaluation,
  type Checkpoint,
  type SearchEvaluation,
} from './schema.js';
import type { Evaluator } from './types.js';

export const SEARCH_PROMPT_VERSION = '5' as const;
export const CAPTURE_PROMPT_VERSION = '5' as const;

export async function evaluateSearchCheckpoint(
  task: NormalizedTask,
  checkpoint: Checkpoint,
  evaluator: Evaluator,
): Promise<SearchEvaluation> {
  const events = evaluationEvents(task, 'search', checkpoint.sequence);
  const result = await evaluator.evaluate({
    prompt: searchPrompt(task, checkpoint, events),
    promptVersion: SEARCH_PROMPT_VERSION,
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    outputSchema: searchProposalBatchSchema,
  });
  for (const proposal of result.output.proposals) {
    if (proposal.checkpointId !== checkpoint.id) {
      throw new Error(
        `search evaluator returned checkpoint ${proposal.checkpointId}; expected ${checkpoint.id}`,
      );
    }
  }
  assertProjectScopes(
    task,
    result.output.proposals.map((proposal) => proposal.search.scope),
  );
  return searchEvaluationSchema.parse({
    checkpoint,
    proposals: result.output.proposals,
    evaluator: result.run,
  });
}

export async function evaluateCaptureTask(
  task: NormalizedTask,
  evaluator: Evaluator,
): Promise<CaptureEvaluation> {
  const events = evaluationEvents(task, 'capture');
  const result = await evaluator.evaluate({
    prompt: capturePrompt(task, events),
    promptVersion: CAPTURE_PROMPT_VERSION,
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    outputSchema: captureProposalBatchSchema,
  });
  for (const proposal of result.output.proposals) {
    if (proposal.taskId !== task.id) {
      throw new Error(`capture evaluator returned task ${proposal.taskId}; expected ${task.id}`);
    }
  }
  assertProjectScopes(
    task,
    result.output.proposals.map((proposal) => proposal.memory.scope),
  );
  return captureEvaluationSchema.parse({
    summary: result.output.summary,
    proposals: result.output.proposals,
    evaluator: result.run,
  });
}

function searchPrompt(
  task: NormalizedTask,
  checkpoint: Checkpoint,
  events: ReturnType<typeof evaluationEvents>,
): string {
  return [
    'Decide whether the agent should search Memento upon reaching this checkpoint. Propose zero',
    'to a small number of targeted searches. Do not try to determine whether matching memories',
    'exist. Return the checkpoint id exactly as supplied. Use only the prefix below; there is no',
    'later task context or memory-store access. Memento calls and results have been removed.',
    '',
    ...evaluatorInstructionHierarchy(
      'decide whether a Memento search was warranted at the supplied checkpoint',
    ),
    ...scopeInstructions(),
    '',
    ...trustedPolicy(SERVER_INSTRUCTIONS),
    '',
    `Task id: ${task.id}`,
    `Checkpoint id: ${checkpoint.id}`,
    ...untrustedSessionEvidence({
      projectContext: task.projectContext ?? {},
      prefixEvents: events,
    }),
  ].join('\n');
}

function capturePrompt(task: NormalizedTask, events: ReturnType<typeof evaluationEvents>): string {
  return [
    'Summarize this completed coding task compactly, then propose zero to a small number of',
    'durable memories it established. Return the task id exactly as supplied and a complete',
    'desired memory record for each proposal. Use update when the context identifies an existing',
    'memory or clearly calls for extending a near-match; targetMemoryId may be null when its id is',
    'not present. All actual Memento calls and results have been removed.',
    '',
    ...evaluatorInstructionHierarchy(
      'identify durable memory opportunities established by the completed coding task',
    ),
    ...scopeInstructions(),
    '',
    ...trustedPolicy(SERVER_INSTRUCTIONS),
    '',
    `Task id: ${task.id}`,
    ...untrustedSessionEvidence({
      projectContext: task.projectContext ?? {},
      completedTaskEvents: events,
    }),
  ].join('\n');
}

type ProposedScope =
  | { kind: 'global' }
  | { kind: 'projects'; project_ids: string[] }
  | { kind: 'unresolved_projects' };

function scopeInstructions(): string[] {
  return [
    '',
    'Scope safety:',
    '- Canonical project ids in any projects scope must be a subset of',
    '  task.projectContext.projectIds.',
    '- If task.projectContext.projectResolutionIncomplete is true, the known ids are only a',
    '  subset: use unresolved_projects for every project-scoped proposal.',
    '- If the operation is project-scoped but those ids are absent or insufficient for every',
    '  relevant project, use {"kind":"unresolved_projects"}. Never invent project ids or use',
    '  global as a fallback. Use global only when the knowledge is true independently of projects.',
  ];
}

function assertProjectScopes(task: NormalizedTask, scopes: ProposedScope[]): void {
  const available = new Set(task.projectContext?.projectIds ?? []);
  for (const scope of scopes) {
    if (scope.kind !== 'projects') continue;
    if (task.projectContext?.projectResolutionIncomplete === true) {
      throw new Error(
        'task project resolution is incomplete; use unresolved_projects instead of a partial scope',
      );
    }
    const invented = scope.project_ids.filter((projectId) => !available.has(projectId));
    if (invented.length === 0) continue;
    throw new Error(
      `evaluator returned project ids absent from task.projectContext.projectIds: ` +
        `${invented.join(', ')}; use unresolved_projects instead`,
    );
  }
}
