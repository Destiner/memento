// Hermetic per-rep sandbox (harness-spec §7.2 steps 1–2 — "this is load-bearing").
// Every rep runs in a throwaway temp tree so the operator's own ~/.claude, MCP
// servers, and git config cannot leak in and silently invalidate results. This
// module materializes that tree and returns its paths; spawning `claude -p` in it
// and tearing it down is the orchestrator's job (§7.2 steps 3–5).
//
// Layout under a fresh temp root:
//   memento-home/memories/  seeded corpus (distractors + the planted fact)
//   repo/                   fixture copy, git-initialised with a baseline commit
//   cc-config/settings.json isolated Claude Code config home (CLAUDE_CONFIG_DIR)
//   mcp.json                the --mcp-config server list (--strict-mcp-config)

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { type Config } from './config.js';
import { generateMcpConfig } from './mcp.js';
import { type Scenario } from './scenario.js';
import { generateSettings } from './settings.js';

export interface SandboxSpec {
  harnessRoot: string; // resolves the scenario's fixture/corpus/seeded_memory
  repoRoot: string; // Memento checkout the MCP server is launched from
  config: Config;
  scenario: Scenario;
  env: 'clean' | 'crowded';
}

export interface Sandbox {
  root: string;
  repoDir: string; // cwd for `claude -p`; the fixture copy (a git repo)
  mementoHome: string; // MEMENTO_HOME for the memento server
  ccConfigDir: string; // CLAUDE_CONFIG_DIR — the isolated config home
  mcpConfigPath: string; // path passed to --mcp-config
  cleanup: () => void;
}

// git isolated from the operator's global/system config for reproducibility; an
// explicit identity is supplied per-commit since there is no global one.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const GIT_IDENTITY = ['-c', 'user.name=harness', '-c', 'user.email=harness@memento.test'];

export function createSandbox(spec: SandboxSpec): Sandbox {
  const { harnessRoot, repoRoot, config, scenario } = spec;
  const root = mkdtempSync(join(tmpdir(), 'memento-rep-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  try {
    const mementoHome = join(root, 'memento-home');
    seedCorpus(harnessRoot, scenario, join(mementoHome, 'memories'));

    const repoDir = join(root, 'repo');
    copyFixture(harnessRoot, scenario, repoDir);
    gitInit(repoDir);

    const ccConfigDir = join(root, 'cc-config');
    mkdirSync(ccConfigDir, { recursive: true });
    writeConfigHome(spec, { mementoHome, repoDir, ccConfigDir });

    const mcpConfigPath = join(root, 'mcp.json');
    writeJson(
      mcpConfigPath,
      generateMcpConfig({
        memento:
          config.memento_variant === null
            ? null
            : { repoRoot, mementoHome, variant: config.memento_variant },
        env: spec.env,
      }),
    );

    return { root, repoDir, mementoHome, ccConfigDir, mcpConfigPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Seed MEMENTO_HOME with the scenario's distractor corpus plus, for retrieve
// classes, the planted fact (§4.2). The memento server rebuilds its index from
// these files on first startup, so only memories/ needs to exist here.
function seedCorpus(harnessRoot: string, scenario: Scenario, memoriesDir: string): void {
  mkdirSync(memoriesDir, { recursive: true });
  const corpusDir = requirePath(join(harnessRoot, scenario.corpus), `corpus "${scenario.corpus}"`);
  for (const name of readdirSync(corpusDir)) {
    if (name.endsWith('.md')) copyFileSync(join(corpusDir, name), join(memoriesDir, name));
  }
  if (scenario.seeded_memory) {
    const fact = requirePath(
      join(harnessRoot, scenario.seeded_memory),
      `seeded_memory "${scenario.seeded_memory}"`,
    );
    copyFileSync(fact, join(memoriesDir, basename(fact)));
  }
}

function copyFixture(harnessRoot: string, scenario: Scenario, repoDir: string): void {
  const fixtureDir = requirePath(
    join(harnessRoot, scenario.fixture),
    `fixture "${scenario.fixture}"`,
  );
  // Fixtures are plain dirs; drop any stray .git so the baseline commit is ours.
  cpSync(fixtureDir, repoDir, { recursive: true, filter: (src) => basename(src) !== '.git' });
}

// A baseline commit so the scorer can diff the session's changes (§5.1 "output/diff").
function gitInit(repoDir: string): void {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoDir, env: GIT_ENV, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git([...GIT_IDENTITY, 'commit', '-q', '-m', 'fixture baseline', '--no-gpg-sign']);
}

// Write the isolated Claude Code config home: settings (memento pre-allowed plus
// the config's optional fragment) and any user-side artifacts the config installs.
function writeConfigHome(
  spec: SandboxSpec,
  paths: { mementoHome: string; repoDir: string; ccConfigDir: string },
): void {
  const { config } = spec;
  const configDir = join(spec.harnessRoot, 'configs', config.name);

  const settings = generateSettings({
    mementoRegistered: config.memento_variant !== null,
    fragment: readSettingsFragment(configDir, config),
  });
  writeJson(join(paths.ccConfigDir, 'settings.json'), settings);

  if (config.install?.claude_md) {
    const src = requirePath(
      join(configDir, config.install.claude_md),
      `config "${config.name}" install.claude_md`,
    );
    // Project-level placement; global (CLAUDE_CONFIG_DIR) placement is a later knob.
    writeFileSync(join(paths.repoDir, 'CLAUDE.md'), readFileSync(src, 'utf8'));
  }

  if (config.install?.hooks?.length || config.install?.skill) {
    throw new Error(
      `config "${config.name}": hook/skill install is not yet supported by the sandbox ` +
        '(added alongside those knobs, §3.2).',
    );
  }
}

function readSettingsFragment(
  configDir: string,
  config: Config,
): Record<string, unknown> | undefined {
  const rel = config.install?.settings;
  if (!rel) return undefined;
  const parsed = JSON.parse(
    readFileSync(
      requirePath(join(configDir, rel), `config "${config.name}" install.settings`),
      'utf8',
    ),
  ) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config "${config.name}" settings fragment must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requirePath(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}.`);
  return path;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
