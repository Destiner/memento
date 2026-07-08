import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { checkUtility, sessionDiff } from './utility.js';

describe('checkUtility', () => {
  // A minimal unified diff that replaces the reset URL: the old value survives on a
  // `-` line, the new value on a `+` line.
  const replaceDiff = [
    'diff --git a/src/reset.ts b/src/reset.ts',
    '--- a/src/reset.ts',
    '+++ b/src/reset.ts',
    '@@ -1 +1 @@',
    "-const base = 'https://app.example.com/reset';",
    "+const base = 'https://account.acme.io/reset';",
  ].join('\n');

  test('passes when the fact is applied and its anti-pattern is absent from added lines', () => {
    expect(
      checkUtility(replaceDiff, {
        utility_regex: '(?i)account\\.acme\\.io',
        utility_anti_regex: '(?i)app\\.example\\.com',
      }),
    ).toBe(true);
  });

  test('a removed line carrying the anti-pattern does not fail utility', () => {
    // The old domain is only on the `-` line; matching it there would wrongly fail
    // a correct replacement. Only added lines count.
    expect(checkUtility(replaceDiff, { utility_regex: '(?i)account\\.acme\\.io' })).toBe(true);
  });

  test('fails when the ruled-out value is introduced on an added line', () => {
    const wrongDiff = [
      '+++ b/src/mail.ts',
      "+import sendgrid from '@sendgrid/mail';",
      '+// switched to postmark eventually',
    ].join('\n');
    expect(
      checkUtility(wrongDiff, {
        utility_regex: '(?i)postmark',
        utility_anti_regex: '(?i)sendgrid',
      }),
    ).toBe(false);
  });

  test('a usage-shaped anti-regex ignores prose mentions of the ruled-out value', () => {
    // email-provider v2: naming the deprecated provider in a comment (or cleaning
    // up its dependency) is not the same as using it — only imports/API usage fail.
    const anti = '(?i)@sendgrid/mail|api\\.sendgrid\\.com';
    const correct = [
      '+++ b/src/email.ts',
      '+// Postmark replaces the deprecated SendGrid integration.',
      '+const token = env.POSTMARK_SERVER_TOKEN;',
    ].join('\n');
    expect(checkUtility(correct, { utility_regex: '(?i)postmark', utility_anti_regex: anti })).toBe(
      true,
    );
    const wrong = "+++ b/src/email.ts\n+import sg from '@sendgrid/mail'; // postmark later";
    expect(checkUtility(wrong, { utility_regex: '(?i)postmark', utility_anti_regex: anti })).toBe(
      false,
    );
  });

  test('fails when the fact never appears in added lines', () => {
    const unrelated = '+++ b/src/x.ts\n+const x = 1;';
    expect(checkUtility(unrelated, { utility_regex: '(?i)postmark' })).toBe(false);
  });

  test('the `+++` header is not mistaken for added content', () => {
    // A filename containing the term must not satisfy the regex on its own.
    const headerOnly = '+++ b/src/postmark.ts\n+const x = 1;';
    expect(checkUtility(headerOnly, { utility_regex: '(?i)postmark' })).toBe(false);
  });
});

describe('sessionDiff', () => {
  let repo: string;
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  function git(args: string[]): void {
    execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
  }

  function commitBaseline(): string {
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git([
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'base',
      '--no-gpg-sign',
    ]);
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
  }

  test('captures modified and new files vs the baseline commit', () => {
    repo = mkdtempSync(join(tmpdir(), 'memento-diff-'));
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    const baseline = commitBaseline();

    // The session modifies a tracked file and adds an untracked one.
    writeFileSync(join(repo, 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'b.ts'), 'const b = 3;\n');

    const diff = sessionDiff(repo, baseline);
    expect(diff).toContain('const a = 2;'); // modification
    expect(diff).toContain('const b = 3;'); // new untracked file
    expect(diff).toContain('-const a = 1;'); // baseline preserved on removal line
  });

  test('a session that commits its own work still diffs against the baseline SHA', () => {
    // Regression: diffing against HEAD would see nothing here, because the agent's
    // own commit moved HEAD onto its changes — a false utility miss (harness-spec §5.1).
    repo = mkdtempSync(join(tmpdir(), 'memento-diff-commit-'));
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    const baseline = commitBaseline();

    writeFileSync(join(repo, 'a.ts'), 'const a = 2;\n');
    git(['add', '-A']);
    git([
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'agent work',
      '--no-gpg-sign',
    ]);

    const diff = sessionDiff(repo, baseline);
    expect(diff).toContain('const a = 2;'); // the change survives the intermediate commit
    expect(diff).toContain('-const a = 1;');
  });
});
