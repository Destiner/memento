import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { scoreRep } from './score.js';
import { type Scenario } from './scenario.js';

let root: string; // harness root (capture baseline)
let home: string; // MEMENTO_HOME
let repo: string; // fixture copy (git)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
}

function commitBaseline(): string {
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base', '--no-gpg-sign']);
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim();
}

function writeEvents(events: Array<Record<string, unknown>>): void {
  const logsDir = join(home, 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'events-2026-07-07.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memento-score-root-'));
  home = mkdtempSync(join(tmpdir(), 'memento-score-home-'));
  repo = mkdtempSync(join(tmpdir(), 'memento-score-repo-'));
});

afterEach(() => {
  for (const dir of [root, home, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('scoreRep', () => {
  test('should-retrieve: computes utility from the diff, calls from the log, oracle guardrail', () => {
    writeFileSync(join(repo, 'mail.ts'), 'export const provider = "todo";\n');
    const baselineRef = commitBaseline();
    writeFileSync(join(repo, 'mail.ts'), 'export const provider = "postmark";\n');
    writeEvents([{ tool: 'search_memory', outcome: 'success' }]);

    const scenario: Scenario = {
      id: 'read/mini',
      version: 1,
      class: 'should-retrieve',
      fixture: 'fixtures/mini',
      task: 'do it',
      corpus: 'corpus/mini',
      seeded_memory: 'facts/planted.md',
      checks: { utility_regex: '(?i)postmark', task_success: 'exit 0' },
    };

    const scored = scoreRep({
      scenario,
      harnessRoot: root,
      mementoHome: home,
      repoDir: repo,
      baselineRef,
      oracleTimeoutS: 10,
    });
    expect(scored.utility_pass).toBe(true);
    expect(scored.task_success).toBe(true);
    expect(scored.capture).toBeNull();
    expect(scored.memento_calls).toEqual([{ tool: 'search_memory', outcome: 'success' }]);
  });

  test('should-not-retrieve: no utility/capture scoring, just calls and the guardrail', () => {
    writeFileSync(join(repo, 'x.ts'), 'const x = 1;\n');
    const baselineRef = commitBaseline();
    writeEvents([{ tool: 'search_memory', outcome: 'success' }]); // an FP the report will count

    const scenario: Scenario = {
      id: 'no-read/mini',
      version: 1,
      class: 'should-not-retrieve',
      fixture: 'fixtures/mini',
      task: 'do it',
      corpus: 'corpus/mini',
      checks: { task_success: 'exit 1' },
    };

    const scored = scoreRep({
      scenario,
      harnessRoot: root,
      mementoHome: home,
      repoDir: repo,
      baselineRef,
      oracleTimeoutS: 10,
    });
    expect(scored.utility_pass).toBeNull();
    expect(scored.capture).toBeNull();
    expect(scored.task_success).toBe(false); // exit 1 → guardrail fails
    expect(scored.memento_calls).toHaveLength(1);
  });

  test('should-capture: scores the rubric against the new memory', () => {
    // One seeded distractor in the corpus; the session captures a fresh memory.
    mkdirSync(join(root, 'corpus', 'mini'), { recursive: true });
    writeFileSync(
      join(root, 'corpus', 'mini', 'd.md'),
      '---\nid: mem_D\ntitle: Distractor\nscope: project\n---\n\n## Summary\n\nnoise\n',
    );
    const memoriesDir = join(home, 'memories');
    mkdirSync(memoriesDir, { recursive: true });
    writeFileSync(
      join(memoriesDir, 'd.md'),
      '---\nid: mem_D\ntitle: Distractor\nscope: project\n---\n\n## Summary\n\nnoise\n',
    );
    writeFileSync(
      join(memoriesDir, 'new.md'),
      '---\nid: mem_NEW\ntitle: Sandbox rate limit\nscope: cross_project\n---\n\n## Summary\n\nThe API allows 10 requests per minute.\n',
    );
    writeEvents([{ tool: 'create_memory', outcome: 'success', memory_type: 'integration' }]);

    writeFileSync(join(repo, 'x.ts'), 'const x = 1;\n');
    const baselineRef = commitBaseline();

    const scenario: Scenario = {
      id: 'write/mini',
      version: 1,
      class: 'should-capture',
      fixture: 'fixtures/mini',
      task: 'do it',
      corpus: 'corpus/mini',
      checks: { task_success: 'exit 0' },
      capture_rubric: {
        insight_regex: '(?i)10 requests per minute',
        expected_scope: ['cross_project', 'external_tooling'],
      },
    };

    const scored = scoreRep({
      scenario,
      harnessRoot: root,
      mementoHome: home,
      repoDir: repo,
      baselineRef,
      oracleTimeoutS: 10,
    });
    expect(scored.utility_pass).toBeNull();
    expect(scored.task_success).toBe(true);
    expect(scored.capture).toMatchObject({ passed: true, attempted: true, memory_id: 'mem_NEW' });
  });
});
