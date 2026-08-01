import { SERVER_INSTRUCTIONS } from '../src/policy/index.js';
import { evaluationEvents } from './evaluator/context.js';
import {
  EVALUATOR_SCHEMA_VERSION,
  MAX_CHECKPOINTS,
  checkpointCandidateBatchSchema,
  checkpointPlanSchema,
  type CheckpointPlan,
} from './evaluator/schema.js';
import {
  evaluatorInstructionHierarchy,
  trustedPolicy,
  untrustedSessionEvidence,
} from './evaluator/prompt.js';
import type { Evaluator } from './evaluator/types.js';
import type { NormalizedTask } from './tasks.js';

export const CHECKPOINT_PROMPT_VERSION = '3' as const;

export async function planCheckpoints(
  task: NormalizedTask,
  evaluator: Evaluator,
): Promise<CheckpointPlan> {
  const start = task.events.find((event) => event.id === task.rootUserEventId);
  if (start === undefined) throw new Error(`task ${task.id} has no root user event`);

  const visibleEvents = evaluationEvents(task, 'checkpoint');
  const visibleIds = new Set(visibleEvents.map((event) => event.id));
  const sourceEventById = new Map(task.events.map((event) => [event.id, event]));
  const evaluated = await evaluator.evaluate({
    prompt: buildCheckpointPrompt(task, visibleEvents),
    promptVersion: CHECKPOINT_PROMPT_VERSION,
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    outputSchema: checkpointCandidateBatchSchema,
  });

  const seen = new Set([start.id]);
  const meaningful = evaluated.output.checkpoints.map((candidate) => {
    const event = sourceEventById.get(candidate.eventId);
    if (event === undefined || !visibleIds.has(candidate.eventId)) {
      throw new Error(`checkpoint evaluator returned unknown event id ${candidate.eventId}`);
    }
    if (seen.has(candidate.eventId)) return undefined;
    seen.add(candidate.eventId);
    return {
      id: `${task.id}:checkpoint:${candidate.eventId}`,
      eventId: candidate.eventId,
      sequence: event.sequence,
      kind: 'meaningful' as const,
      reason: candidate.reason,
    };
  });

  return checkpointPlanSchema.parse({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    taskId: task.id,
    evaluator: evaluated.run,
    checkpoints: [
      {
        id: `${task.id}:checkpoint:${start.id}`,
        eventId: start.id,
        sequence: start.sequence,
        kind: 'start',
        reason: "Task begins with the user's request.",
      },
      ...meaningful.filter((checkpoint) => checkpoint !== undefined),
    ]
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
      )
      .slice(0, MAX_CHECKPOINTS),
  });
}

function buildCheckpointPrompt(
  task: NormalizedTask,
  events: ReturnType<typeof evaluationEvents>,
): string {
  return [
    'Select meaningful moments in this completed coding task where newly available information',
    'would justify reconsidering whether a memory search is useful. The task start is added',
    'separately. Return zero checkpoints for a simple task, and never select routine progress.',
    'Use only eventId values present below. Memento operations have been removed.',
    '',
    ...evaluatorInstructionHierarchy(
      'select meaningful search-reconsideration checkpoints from the supplied evidence',
    ),
    '',
    ...trustedPolicy(SERVER_INSTRUCTIONS),
    '',
    `Task id: ${task.id}`,
    ...untrustedSessionEvidence({ events }),
  ].join('\n');
}
