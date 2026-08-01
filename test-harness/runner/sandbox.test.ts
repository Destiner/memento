import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { AGENT_FRAGMENT } from '../../src/policy/index.js';
import { type Config } from './config.js';
import { createSandbox, HARNESS_PROJECT_ID, type Sandbox } from './sandbox.js';
import { type Scenario } from './scenario.js';

// A synthetic harness tree keeps the test fast and hermetic — no real fixture
// node_modules to copy. It provides just what createSandbox resolves.
let harnessRoot: string;
const opened: Sandbox[] = [];

beforeAll(() => {
  harnessRoot = mkdtempSync(join(tmpdir(), 'memento-harness-'));
  mkdirSync(join(harnessRoot, 'corpus', 'mini'), { recursive: true });
  writeFileSync(join(harnessRoot, 'corpus', 'mini', 'a.md'), '# a\n');
  writeFileSync(join(harnessRoot, 'corpus', 'mini', 'b.md'), '# b\n');
  writeFileSync(join(harnessRoot, 'corpus', 'mini', 'notes.txt'), 'ignored\n'); // non-.md skipped
  mkdirSync(join(harnessRoot, 'facts'), { recursive: true });
  writeFileSync(join(harnessRoot, 'facts', 'planted.md'), '# planted\n');
  mkdirSync(join(harnessRoot, 'fixtures', 'mini', 'src', 'sub'), { recursive: true });
  writeFileSync(join(harnessRoot, 'fixtures', 'mini', 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(harnessRoot, 'fixtures', 'mini', 'src', 'sub', 'deep.ts'),
    'export const z = 1;\n',
  );
  // An overlay that overwrites base files (including a nested one) and adds a new
  // file — the nesting mirrors real overlays and guards the overwrite path.
  mkdirSync(join(harnessRoot, 'overlays', 'mini-staged', 'src', 'sub'), { recursive: true });
  writeFileSync(
    join(harnessRoot, 'overlays', 'mini-staged', 'src', 'index.ts'),
    'export const x = 42;\n',
  );
  writeFileSync(
    join(harnessRoot, 'overlays', 'mini-staged', 'src', 'extra.ts'),
    'export const y = 2;\n',
  );
  writeFileSync(
    join(harnessRoot, 'overlays', 'mini-staged', 'src', 'sub', 'deep.ts'),
    'export const z = 99;\n',
  );
  mkdirSync(join(harnessRoot, 'configs', 'with-claude-md'), { recursive: true });
  writeFileSync(join(harnessRoot, 'configs', 'with-claude-md', 'CLAUDE.md'), 'use memento\n');
  mkdirSync(join(harnessRoot, 'configs', 'with-settings'), { recursive: true });
  writeFileSync(
    join(harnessRoot, 'configs', 'with-settings', 'frag.json'),
    JSON.stringify({ permissions: { allow: ['Bash(bun run:*)'] } }),
  );
  // A hook config: a settings fragment wiring a SessionStart command that
  // references the per-rep {{HOOKS_DIR}}/{{MEMENTO_HOME}} tokens, plus the script.
  mkdirSync(join(harnessRoot, 'configs', 'with-hook'), { recursive: true });
  writeFileSync(
    join(harnessRoot, 'configs', 'with-hook', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: "MEMENTO_HOME='{{MEMENTO_HOME}}' bun '{{HOOKS_DIR}}/h.ts'",
              },
            ],
          },
        ],
      },
    }),
  );
  writeFileSync(join(harnessRoot, 'configs', 'with-hook', 'h.ts'), 'process.stdout.write("hi");\n');
  // A skill config: a skill directory copied into the isolated config home.
  mkdirSync(join(harnessRoot, 'configs', 'with-skill', 'skill'), { recursive: true });
  writeFileSync(join(harnessRoot, 'configs', 'with-skill', 'skill', 'SKILL.md'), '# skill\n');
});

afterEach(() => {
  while (opened.length) opened.pop()?.cleanup();
});

afterAll(() => rmSync(harnessRoot, { recursive: true, force: true }));

function open(spec: { config: Config; scenario: Scenario; env?: 'clean' | 'crowded' }): Sandbox {
  const sandbox = createSandbox({
    harnessRoot,
    serverEntry: '/srv/server.js',
    env: spec.env ?? 'clean',
    config: spec.config,
    scenario: spec.scenario,
  });
  opened.push(sandbox);
  return sandbox;
}

const RETRIEVE_SCENARIO: Scenario = {
  id: 'read/mini',
  version: 1,
  class: 'should-retrieve',
  fixture: 'fixtures/mini',
  task: 'do it',
  corpus: 'corpus/mini',
  seeded_memory: 'facts/planted.md',
  checks: { utility_regex: '(?i)x' },
};

const BASELINE_0: Config = {
  name: 'baseline-0',
  knob: 'none',
  variant: 'none',
  side: 'both',
  portability: 'portable',
  memento_variant: 'plain',
};

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('createSandbox', () => {
  test('seeds the corpus and planted fact into MEMENTO_HOME/memories', () => {
    const sandbox = open({ config: BASELINE_0, scenario: RETRIEVE_SCENARIO });
    const seeded = readdirSync(join(sandbox.mementoHome, 'memories')).sort();
    expect(seeded).toEqual(['a.md', 'b.md', 'planted.md']);
  });

  test('registers the synthetic checkout so V2 project resolution can succeed', () => {
    const sandbox = open({ config: BASELINE_0, scenario: RETRIEVE_SCENARIO });
    const project = readFileSync(
      join(sandbox.mementoHome, 'projects', `${HARNESS_PROJECT_ID}-harness-app.md`),
      'utf8',
    );
    expect(project).toContain(`id: ${HARNESS_PROJECT_ID}`);
    expect(project).toContain(sandbox.repoDir);
  });

  test('applies a scenario overlay on top of the fixture', () => {
    const scenario: Scenario = { ...RETRIEVE_SCENARIO, overlay: 'overlays/mini-staged' };
    const sandbox = open({ config: BASELINE_0, scenario });
    // Overlay overwrites a base file, including a nested one...
    expect(readFileSync(join(sandbox.repoDir, 'src', 'index.ts'), 'utf8')).toBe(
      'export const x = 42;\n',
    );
    expect(readFileSync(join(sandbox.repoDir, 'src', 'sub', 'deep.ts'), 'utf8')).toBe(
      'export const z = 99;\n',
    );
    // ...and adds a new one, all landing in the baseline commit.
    expect(readFileSync(join(sandbox.repoDir, 'src', 'extra.ts'), 'utf8')).toBe(
      'export const y = 2;\n',
    );
  });

  test('copies the fixture into a git repo with a baseline commit', () => {
    const sandbox = open({ config: BASELINE_0, scenario: RETRIEVE_SCENARIO });
    expect(existsSync(join(sandbox.repoDir, 'src', 'index.ts'))).toBe(true);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sandbox.repoDir,
      encoding: 'utf8',
    }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // The recorded baseline SHA is the diff base the scorer uses (utility.ts).
    expect(sandbox.baselineRef).toBe(head);
  });

  test('writes an MCP config and settings that register and pre-allow memento', () => {
    const sandbox = open({ config: BASELINE_0, scenario: RETRIEVE_SCENARIO });
    const mcp = readJson(sandbox.mcpConfigPath);
    const servers = mcp.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.memento?.env.MEMENTO_VARIANT).toBe('plain');
    expect(servers.memento?.env.MEMENTO_HOME).toBe(sandbox.mementoHome);
    const settings = readJson(join(sandbox.ccConfigDir, 'settings.json'));
    expect(settings.permissions).toEqual({ allow: ['mcp__memento'] });
  });

  test('registers no server and allows nothing for baseline-no-memento', () => {
    const config: Config = { ...BASELINE_0, name: 'baseline-no-memento', memento_variant: null };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    expect(readJson(sandbox.mcpConfigPath).mcpServers).toEqual({});
    expect(readJson(join(sandbox.ccConfigDir, 'settings.json')).permissions).toEqual({ allow: [] });
  });

  test('installs a project CLAUDE.md fragment when the config declares one', () => {
    const config: Config = {
      ...BASELINE_0,
      name: 'with-claude-md',
      knob: 'claude-md',
      install: { claude_md: 'CLAUDE.md' },
    };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    expect(readFileSync(join(sandbox.repoDir, 'CLAUDE.md'), 'utf8')).toBe('use memento\n');
  });

  test('installs the canonical generated fragment under the adapter filename', () => {
    const config: Config = {
      ...BASELINE_0,
      name: 'with-claude-md',
      knob: 'claude-md',
      install: { agent_instructions: 'memento' },
    };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    expect(readFileSync(join(sandbox.repoDir, 'CLAUDE.md'), 'utf8')).toBe(AGENT_FRAGMENT);
  });

  test('merges a config settings fragment over the memento allowance', () => {
    const config: Config = {
      ...BASELINE_0,
      name: 'with-settings',
      knob: 'permissions',
      install: { settings: 'frag.json' },
    };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    expect(readJson(join(sandbox.ccConfigDir, 'settings.json')).permissions).toEqual({
      allow: ['mcp__memento', 'Bash(bun run:*)'],
    });
  });

  test('installs hook scripts and resolves per-rep tokens in the settings command', () => {
    const config: Config = {
      ...BASELINE_0,
      name: 'with-hook',
      knob: 'sessionstart-hook',
      install: { hooks: ['h.ts'], settings: 'settings.json' },
    };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    // The hook script is copied into the config home's hooks/ dir.
    expect(readFileSync(join(sandbox.ccConfigDir, 'hooks', 'h.ts'), 'utf8')).toBe(
      'process.stdout.write("hi");\n',
    );
    // {{HOOKS_DIR}} and {{MEMENTO_HOME}} in the command resolve to the rep's paths.
    const settings = readJson(join(sandbox.ccConfigDir, 'settings.json'));
    const hooks = settings.hooks as { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    const command = hooks.SessionStart[0]!.hooks[0]!.command;
    expect(command).toContain(join(sandbox.ccConfigDir, 'hooks', 'h.ts'));
    expect(command).toContain(sandbox.mementoHome);
    expect(command).not.toContain('{{');
  });

  test('installs a skill directory into the isolated config home', () => {
    const config: Config = {
      ...BASELINE_0,
      name: 'with-skill',
      knob: 'memento-skill',
      install: { skill: 'skill' },
    };
    const sandbox = open({ config, scenario: RETRIEVE_SCENARIO });
    expect(readFileSync(join(sandbox.ccConfigDir, 'skills', 'skill', 'SKILL.md'), 'utf8')).toBe(
      '# skill\n',
    );
  });

  test('cleanup removes the whole sandbox tree', () => {
    const sandbox = createSandbox({
      harnessRoot,
      serverEntry: '/srv/server.js',
      env: 'clean',
      config: BASELINE_0,
      scenario: RETRIEVE_SCENARIO,
    });
    expect(existsSync(sandbox.root)).toBe(true);
    expect(existsSync(sandbox.repoDir)).toBe(true);
    sandbox.cleanup();
    expect(existsSync(sandbox.root)).toBe(false);
    expect(existsSync(sandbox.repoDir)).toBe(false);
  });

  test('private state is not reachable by exploring up from the session cwd', () => {
    // With memento-home/ as a sibling of repo/, `ls ..` exposes the seeded corpus
    // as plain files. The workspace must sit in its own temp root.
    const sandbox = createSandbox({
      harnessRoot,
      serverEntry: '/srv/server.js',
      env: 'clean',
      config: BASELINE_0,
      scenario: RETRIEVE_SCENARIO,
    });
    try {
      const workParent = dirname(sandbox.repoDir);
      expect(readdirSync(workParent)).toEqual(['repo']);
      expect(sandbox.mementoHome.startsWith(workParent)).toBe(false);
      expect(sandbox.ccConfigDir.startsWith(workParent)).toBe(false);
      // The config home's path leaks via env (CODEX_HOME/CLAUDE_CONFIG_DIR), so
      // ITS parent must also expose nothing — memento-home was its sibling once.
      const cfgParent = dirname(sandbox.ccConfigDir);
      expect(readdirSync(cfgParent)).toEqual(['cc-config']);
      expect(sandbox.mementoHome.startsWith(cfgParent)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });
});
