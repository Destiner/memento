// Fixture oracle runner (harness-spec §4.3, §5.3). Each scenario names a
// `task_success` command (e.g. `bun run check`) that the fixture ships as its
// success oracle — a test suite or checklist run inside the post-session fixture
// copy. Exit 0 means the task was completed correctly.
//
// task_success is a guardrail (§5.3), not a primary score: a config that regresses
// it is disqualified regardless of its read/write scores. Output is discarded — we
// only need the verdict — but the command inherits the environment so `bun`, `tsc`,
// and the fixture's node_modules resolve as they would for a developer.

import { spawnSync } from 'node:child_process';

export interface OracleResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

/** Run the scenario's task_success command in the fixture copy, SIGKILLing it
 *  after `timeoutS`. Never throws: a spawn failure or timeout resolves to a
 *  non-pass verdict the caller records. */
export function runOracle(command: string, repoDir: string, timeoutS: number): OracleResult {
  const result = spawnSync('sh', ['-c', command], {
    cwd: repoDir,
    timeout: timeoutS * 1000,
    stdio: 'ignore',
    killSignal: 'SIGKILL',
  });
  const timedOut =
    result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    passed: !result.error && result.status === 0,
    exitCode: result.status,
    timedOut,
  };
}
