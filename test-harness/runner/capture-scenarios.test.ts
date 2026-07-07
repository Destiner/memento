// Calibration for the should-capture scenarios (harness-spec §11.2b): the
// discovery is forced and the fact is discoverable *and* completable, without a
// live agent. For each write/* scenario, in a real fixture+overlay copy:
//   - the naive invocation fails and its message matches the scenario's own
//     insight_regex — so what the agent can discover is exactly what the capture
//     rubric requires it to record (closing the discover↔capture loop);
//   - the correct invocation succeeds and leaves the task_success marker.
// Also confirms the overlay greens `bun run check` so the guardrail isolates the
// discovery task from the fixture's pre-existing unimplemented paths.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compilePattern } from './pattern.js';
import { loadScenario } from './scenario.js';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The correct/naive invocations per scenario. The scenario.yaml deliberately does
// not encode how to succeed — that is what the agent must discover — so the
// calibration supplies it here and cross-checks against the committed rubric.
const CASES = [
  {
    id: 'write/migrate-single-tx',
    script: 'scripts/migrate.ts',
    correctArgs: ['--single-tx'],
    correctEnv: {},
    marker: '.migrate-applied',
  },
  {
    id: 'write/email-sandbox-stream',
    script: 'scripts/send-test-email.ts',
    correctArgs: [],
    correctEnv: { POSTMARK_STREAM: 'outbound' },
    marker: '.test-email-sent',
  },
  {
    id: 'write/seed-idempotency',
    script: 'scripts/seed-users.ts',
    correctArgs: ['--idempotency-key=run-1'],
    correctEnv: {},
    marker: '.users-seeded',
  },
] as const;

let repo: string; // one fixture+overlay copy shared across cases (markers are distinct)

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'memento-capscen-'));
  cpSync(join(HARNESS_ROOT, 'fixtures', 'saas-app'), repo, { recursive: true });
  cpSync(join(HARNESS_ROOT, 'overlays', 'saas-app-ops'), repo, { recursive: true });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('should-capture scenarios calibrate', () => {
  test('the overlay greens bun run check (guardrail baseline)', () => {
    // Throws if check fails, failing the test with the tsc/bun output.
    execFileSync('bun', ['run', 'check'], { cwd: repo, encoding: 'utf8' });
  });

  for (const c of CASES) {
    test(`${c.id}: naive fails with the discoverable insight, correct completes`, () => {
      const scenario = loadScenario(join(HARNESS_ROOT, 'scenarios', c.id, 'scenario.yaml'));
      const insight = compilePattern(scenario.capture_rubric!.insight_regex);

      // Naive invocation: non-zero exit, no marker, and a message that records
      // exactly what the rubric's insight_regex looks for.
      let naiveErr = '';
      let naiveFailed = false;
      try {
        execFileSync('bun', [c.script], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        naiveFailed = true;
        naiveErr = String((error as { stderr?: Buffer | string }).stderr ?? '');
      }
      expect(naiveFailed).toBe(true);
      expect(existsSync(join(repo, c.marker))).toBe(false);
      expect(insight.test(naiveErr)).toBe(true);

      // Correct invocation: throws (failing the test) on a non-zero exit, then
      // the task_success marker must exist.
      execFileSync('bun', [c.script, ...c.correctArgs], {
        cwd: repo,
        env: { ...process.env, ...c.correctEnv },
        encoding: 'utf8',
      });
      expect(existsSync(join(repo, c.marker))).toBe(true);
    });
  }
});
