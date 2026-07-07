// Rep scorer (harness-spec §5, §7.2 step 4). Ties the individual scorers together
// into the ScoredFacts the results record stores (§8.2 raw): the Memento calls a
// session made, whether the seeded fact was applied (should-retrieve), whether the
// task oracle passed, and the capture rubric result (should-capture).
//
// Only the class's own primary metric is computed — utility for should-retrieve,
// the rubric for should-capture — because the false-positive rates for the
// should-not-* classes are derived from memento_calls at report time (§5.4: scores
// are recomputed from the log). task_success is a guardrail for every class (§5.3),
// so it always runs. The oracle runs last: it executes in the fixture copy and
// could touch files, so it must not perturb the diff the utility check reads.

import {
  findCapturedMemories,
  scoreCapture,
  seededBaseline,
  type CaptureResult,
} from './capture.js';
import { readMementoCalls, type MementoCall } from './event-log.js';
import { runOracle } from './oracle.js';
import { type ScoredFacts } from './record.js';
import { type Scenario } from './scenario.js';
import { checkUtility, sessionDiff } from './utility.js';

export interface ScoreInput {
  scenario: Scenario;
  harnessRoot: string; // resolves the scenario's seeded corpus (capture baseline)
  mementoHome: string; // event log + captured memory files
  repoDir: string; // fixture copy — session diff + oracle
  oracleTimeoutS: number;
}

export function scoreRep(input: ScoreInput): ScoredFacts {
  const { scenario, repoDir } = input;
  const memento_calls: MementoCall[] = readMementoCalls(input.mementoHome);

  let utility_pass: boolean | null = null;
  if (scenario.class === 'should-retrieve' && scenario.checks.utility_regex) {
    utility_pass = checkUtility(sessionDiff(repoDir), {
      utility_regex: scenario.checks.utility_regex,
      utility_anti_regex: scenario.checks.utility_anti_regex,
    });
  }

  let capture: CaptureResult | null = null;
  if (scenario.class === 'should-capture' && scenario.capture_rubric) {
    const baseline = seededBaseline(input.harnessRoot, scenario.corpus, scenario.seeded_memory);
    const captured = findCapturedMemories(input.mementoHome, baseline);
    capture = scoreCapture(memento_calls, captured, scenario.capture_rubric);
  }

  const task_success = scenario.checks.task_success
    ? runOracle(scenario.checks.task_success, repoDir, input.oracleTimeoutS).passed
    : null;

  return { memento_calls, utility_pass, task_success, capture };
}
