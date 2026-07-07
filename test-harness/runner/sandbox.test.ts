import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { type Config } from './config.js';
import { createSandbox, type Sandbox } from './sandbox.js';
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
  mkdirSync(join(harnessRoot, 'fixtures', 'mini', 'src'), { recursive: true });
  writeFileSync(join(harnessRoot, 'fixtures', 'mini', 'src', 'index.ts'), 'export const x = 1;\n');
  mkdirSync(join(harnessRoot, 'configs', 'with-claude-md'), { recursive: true });
  writeFileSync(join(harnessRoot, 'configs', 'with-claude-md', 'CLAUDE.md'), 'use memento\n');
  mkdirSync(join(harnessRoot, 'configs', 'with-settings'), { recursive: true });
  writeFileSync(
    join(harnessRoot, 'configs', 'with-settings', 'frag.json'),
    JSON.stringify({ permissions: { allow: ['Bash(bun run:*)'] } }),
  );
});

afterEach(() => {
  while (opened.length) opened.pop()?.cleanup();
});

afterAll(() => rmSync(harnessRoot, { recursive: true, force: true }));

function open(spec: { config: Config; scenario: Scenario; env?: 'clean' | 'crowded' }): Sandbox {
  const sandbox = createSandbox({
    harnessRoot,
    repoRoot: '/repo',
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

  test('copies the fixture into a git repo with a baseline commit', () => {
    const sandbox = open({ config: BASELINE_0, scenario: RETRIEVE_SCENARIO });
    expect(existsSync(join(sandbox.repoDir, 'src', 'index.ts'))).toBe(true);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sandbox.repoDir,
      encoding: 'utf8',
    }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
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

  test('rejects hook/skill installs until the sandbox supports them', () => {
    const config: Config = {
      ...BASELINE_0,
      knob: 'sessionstart-hook',
      install: { hooks: ['h.ts'] },
    };
    expect(() => open({ config, scenario: RETRIEVE_SCENARIO })).toThrow(/not yet supported/);
  });

  test('cleanup removes the whole sandbox tree', () => {
    const sandbox = createSandbox({
      harnessRoot,
      repoRoot: '/repo',
      env: 'clean',
      config: BASELINE_0,
      scenario: RETRIEVE_SCENARIO,
    });
    expect(existsSync(sandbox.root)).toBe(true);
    sandbox.cleanup();
    expect(existsSync(sandbox.root)).toBe(false);
  });
});
