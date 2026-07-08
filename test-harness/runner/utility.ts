// Utility check (harness-spec §5.1). For should-retrieve scenarios the seeded
// fact "can't appear unless the model searched, read, and applied it", so utility
// is a regex over what the session *introduced*: `utility_regex` must match (the
// fact was applied) and `utility_anti_regex`, if given, must not (the ruled-out
// value was not used).
//
// The haystack is the *added* lines of the session's diff, not the whole diff.
// This matters for the replace case: fixing a wrong value (account.acme.io over
// app.example.com) leaves the old value on a `-` line, and matching an anti-regex
// against a removed line would wrongly fail a correct edit. Added lines are
// exactly what the agent wrote — which is what "applied it in the diff" means (the
// wording every should-retrieve scenario uses). Removed lines and the agent's
// prose answer are deliberately excluded.

import { execFileSync } from 'node:child_process';

import { compilePattern } from './pattern.js';

// git isolated from the operator's config for reproducibility, matching the
// sandbox's baseline commit (sandbox.ts). node_modules is excluded so a session
// that reran `bun install` can't bury the real edit in lockfile churn.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const PATHSPEC = ['--', '.', ':(exclude)node_modules'];

export interface UtilityChecks {
  utility_regex: string;
  utility_anti_regex?: string;
}

/**
 * The session's changes vs the recorded fixture baseline commit, as a unified
 * diff. Stages everything first so new (untracked) files are included; the sandbox
 * is disposable, so mutating its index is harmless.
 *
 * `baseline` is the baseline commit SHA captured at git init (sandbox.ts), *not*
 * HEAD: a session that git-commits its own work moves HEAD onto that commit, so
 * `--cached HEAD` would see an empty diff and score a false utility miss. Diffing
 * the staged working tree against the fixed baseline SHA captures every change
 * since checkout regardless of any commits the session made.
 */
export function sessionDiff(repoDir: string, baseline: string): string {
  execFileSync('git', ['add', '-A', ...PATHSPEC], {
    cwd: repoDir,
    env: GIT_ENV,
    stdio: 'ignore',
  });
  return execFileSync('git', ['diff', '--cached', baseline, ...PATHSPEC], {
    cwd: repoDir,
    env: GIT_ENV,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Whether the seeded fact was applied without violating its anti-pattern. */
export function checkUtility(diff: string, checks: UtilityChecks): boolean {
  const introduced = addedLines(diff);
  if (!compilePattern(checks.utility_regex).test(introduced)) return false;
  if (checks.utility_anti_regex && compilePattern(checks.utility_anti_regex).test(introduced))
    return false;
  return true;
}

// The content the diff *adds*: `+` lines minus the `+++` file headers, stripped of
// the leading `+`. This is the code the session introduced.
function addedLines(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out.join('\n');
}
