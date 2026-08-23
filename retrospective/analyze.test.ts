import { describe, expect, test } from 'vitest';

import { analyzeTask } from './analyze.js';
import type { EvaluationRequest, EvaluationResult, Evaluator } from './evaluator/types.js';
import type { NormalizedTask } from './tasks.js';

const task: NormalizedTask = {
  schemaVersion: 1,
  id: 'task-1',
  sessionId: 'session-1',
  index: 0,
  rootUserEventId: 'user-1',
  client: 'claude-code',
  policyVersion: 'unknown',
  startSequence: 1,
  endSequence: 2,
  events: [
    {
      schemaVersion: 1,
      id: 'user-1',
      sessionId: 'session-1',
      threadId: 'root',
      sequence: 1,
      kind: 'user_message',
      role: 'user',
      text: 'Rename the local variable.',
    },
    {
      schemaVersion: 1,
      id: 'done',
      sessionId: 'session-1',
      threadId: 'root',
      sequence: 2,
      kind: 'assistant_message',
      role: 'assistant',
      text: 'Renamed it.',
    },
  ],
  actualOperations: [],
};

class ZeroProposalEvaluator implements Evaluator {
  readonly provider = 'claude-code' as const;
  readonly model = 'claude-test';
  readonly prompts: string[] = [];

  async identity() {
    return {
      provider: this.provider,
      cli: 'claude' as const,
      cliVersion: '2.1.220',
      model: this.model,
    };
  }

  async evaluate<Output>(request: EvaluationRequest<Output>): Promise<EvaluationResult<Output>> {
    this.prompts.push(request.prompt);
    const output = request.prompt.includes('Select meaningful moments')
      ? { checkpoints: [] }
      : request.prompt.includes('Summarize this completed')
        ? { summary: 'Renamed one local variable; TOKEN=supersecret.', proposals: [] }
        : { proposals: [] };
    return {
      output: request.outputSchema.parse(output),
      run: {
        provider: this.provider,
        cli: 'claude',
        cliVersion: '2.1.220',
        model: this.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        policyVersion: '2.1.0',
      },
    };
  }
}

describe('analyzeTask', () => {
  test('runs checkpoint, prefix search, capture, comparison, and final validation', async () => {
    const evaluator = new ZeroProposalEvaluator();
    const result = await analyzeTask(task, evaluator);

    expect(result.taskId).toBe(task.id);
    expect(result.checkpointPlan.checkpoints).toHaveLength(1);
    expect(result.searchEvaluations).toHaveLength(1);
    expect(result.captureEvaluation.summary).toBe('Renamed one local variable; [REDACTED:SECRET]');
    expect(result.comparisons).toEqual([]);
    expect(evaluator.prompts).toHaveLength(3);
    expect(result.checkpointPlan.evaluator.cliVersion).toBe('2.1.220');
    expect(result.searchEvaluations[0]?.evaluator.promptVersion).toBe('6');
    expect(result.captureEvaluation.evaluator.schemaVersion).toBe('3');
  });
});
