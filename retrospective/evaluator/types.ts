import type { z } from 'zod';

import type { EvaluatorRun } from './schema.js';

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}

export interface EvaluationRequest<Output> {
  prompt: string;
  promptVersion: string;
  schemaVersion: string;
  outputSchema: z.ZodType<Output>;
}

export interface EvaluationResult<Output> {
  output: Output;
  run: EvaluatorRun;
}

export interface EvaluatorRuntimeIdentity {
  provider: 'claude-code' | 'codex';
  cli: 'claude' | 'codex';
  cliVersion: string;
  model: string;
}

export interface Evaluator {
  readonly provider: 'claude-code' | 'codex';
  readonly model: string;
  identity(): Promise<EvaluatorRuntimeIdentity>;
  evaluate<Output>(request: EvaluationRequest<Output>): Promise<EvaluationResult<Output>>;
}
