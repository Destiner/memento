// Hermetic per-rep sandbox (harness-spec §7.2 steps 1–2 — "this is load-bearing").
// Every rep runs in a throwaway temp tree so the operator's own ~/.claude, MCP
// servers, and git config cannot leak in and silently invalidate results. This
// module materializes that tree and returns its paths; spawning `claude -p` in it
// and tearing it down is the orchestrator's job (§7.2 steps 3–5).
//
// Layout across TWO fresh temp roots (the agent's `..` must expose nothing):
//   private root:  memento-home/memories/  seeded corpus (distractors + fact)
//                  cc-config/              isolated config home
//                  mcp.json / config.toml  MCP registration (per adapter)
//   work root:     repo/                   fixture copy (+ overlay), git repo —
//                                          the ONLY tree the session cwd can see

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
import { makeAdapter, type HarnessAdapter } from './harness.js';
import { generateMcpConfig } from './mcp.js';
import { type Scenario } from './scenario.js';
import { generateSettings } from './settings.js';

export interface SandboxSpec {
  harnessRoot: string; // resolves the scenario's fixture/corpus/seeded_memory
  serverEntry: string; // bundled memento server file (preflight.ts)
  config: Config;
  scenario: Scenario;
  env: 'clean' | 'crowded';
  // Defaults to claude-code; codex changes the config-home layout, the MCP
  // registration format, and the instructions filename (harness.ts).
  adapter?: HarnessAdapter;
}

export interface Sandbox {
  root: string;
  repoDir: string; // cwd for `claude -p`; the fixture copy (a git repo)
  mementoHome: string; // MEMENTO_HOME for the memento server
  ccConfigDir: string; // CLAUDE_CONFIG_DIR — the isolated config home
  mcpConfigPath: string; // path passed to --mcp-config
  baselineRef: string; // fixture baseline commit SHA — the diff base (utility.ts)
  cleanup: () => void;
}

// git isolated from the operator's global/system config for reproducibility; an
// explicit identity is supplied per-commit since there is no global one.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const GIT_IDENTITY = ['-c', 'user.name=harness', '-c', 'user.email=harness@memento.test'];

export function createSandbox(spec: SandboxSpec): Sandbox {
  const { harnessRoot, serverEntry, config, scenario } = spec;
  const adapter = spec.adapter ?? makeAdapter('claude-code');
  const root = mkdtempSync(join(tmpdir(), 'memento-rep-'));
  // The agent's workspace lives in its OWN temp root: `..` from the session cwd
  // must expose nothing. With repo/ as a sibling of memento-home/, one `ls ..`
  // hands the agent the whole seeded corpus as plain files — codex-screening-1
  // "passed" utility this way with zero MCP calls (§7.2 hermetic isolation).
  const workRoot = mkdtempSync(join(tmpdir(), 'memento-work-'));
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  };

  try {
    const mementoHome = join(root, 'memento-home');
    seedCorpus(harnessRoot, scenario, join(mementoHome, 'memories'));

    const repoDir = join(workRoot, 'repo');
    copyFixture(harnessRoot, scenario, repoDir);
    const baselineRef = gitInit(repoDir);

    const ccConfigDir = join(root, 'cc-config');
    mkdirSync(ccConfigDir, { recursive: true });
    writeConfigHome(spec, adapter, { mementoHome, repoDir, ccConfigDir });

    const mcpConfigPath = adapter.writeMcpRegistration(
      { root, configHome: ccConfigDir },
      generateMcpConfig({
        memento:
          config.memento_variant === null
            ? null
            : { serverEntry, mementoHome, variant: config.memento_variant },
        env: spec.env,
        stubs: { stubsDir: join(harnessRoot, 'stubs') },
      }),
    );

    return { root, repoDir, mementoHome, ccConfigDir, mcpConfigPath, baselineRef, cleanup };
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

  // An optional overlay is copied on top, overwriting base files. It stages the
  // scenario's baseline without forking the whole fixture: e.g. completing an app
  // so a should-not-* edit keeps the oracle green, or planting a discovery
  // artifact for should-capture (§4.3). The overlay is part of the baseline
  // commit, so it never shows up in the session diff the scorer reads.
  if (scenario.overlay) {
    const overlayDir = requirePath(
      join(harnessRoot, scenario.overlay),
      `overlay "${scenario.overlay}"`,
    );
    overlayOnto(overlayDir, repoDir);
  }
}

// Copy every file in src over dest, overwriting and creating dirs as needed,
// skipping .git. Not cpSync: under Bun (the runner's runtime) cpSync silently
// refuses to overwrite existing files when a `filter` is supplied, so a filtered
// overlay copy would leave the base files untouched.
function overlayOnto(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      overlayOnto(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}

// A baseline commit so the scorer can diff the session's changes (§5.1 "output/diff").
// Returns the baseline commit SHA: the diff base (utility.ts) is this fixed SHA,
// not HEAD, so a session that commits its own work can't move the base out from
// under the scorer and produce a false utility miss.
function gitInit(repoDir: string): string {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoDir, env: GIT_ENV, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git([...GIT_IDENTITY, 'commit', '-q', '-m', 'fixture baseline', '--no-gpg-sign']);
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim();
}

// Write the isolated Claude Code config home: settings (memento pre-allowed plus
// the config's optional fragment) and any user-side artifacts the config installs
// (CLAUDE.md, hook scripts, a skill dir — §3.2, §7.2 step 2).
function writeConfigHome(
  spec: SandboxSpec,
  adapter: HarnessAdapter,
  paths: { mementoHome: string; repoDir: string; ccConfigDir: string },
): void {
  const { config } = spec;
  const configDir = join(spec.harnessRoot, 'configs', config.name);
  const hooksDir = join(paths.ccConfigDir, 'hooks');

  // Per-rep paths a committed settings fragment can't hardcode (the sandbox is a
  // fresh temp tree each rep). A fragment references them by token — e.g. a hook
  // command as `bun run '{{HOOKS_DIR}}/x.ts'` — and the installer resolves them.
  const tokens: Record<string, string> = {
    '{{MEMENTO_HOME}}': paths.mementoHome,
    '{{HOOKS_DIR}}': hooksDir,
    '{{REPO_DIR}}': paths.repoDir,
    '{{CONFIG_DIR}}': paths.ccConfigDir,
  };

  if (adapter.supportsSettings) {
    const fragment = readSettingsFragment(configDir, config);
    const settings = generateSettings({
      mementoRegistered: config.memento_variant !== null,
      fragment: fragment && (substituteTokens(fragment, tokens) as Record<string, unknown>),
    });
    writeJson(join(paths.ccConfigDir, 'settings.json'), settings);
  } else if (config.install?.settings || config.install?.hooks?.length || config.install?.skill) {
    // plan.ts gates non-portable installs per harness; defend anyway so a bypass
    // fails loudly instead of silently running a knob-less rep (§3.2).
    throw new Error(
      `config "${config.name}": settings/hooks/skill installs are not supported by ${adapter.name}.`,
    );
  }

  if (config.install?.claude_md) {
    const src = requirePath(
      join(configDir, config.install.claude_md),
      `config "${config.name}" install.claude_md`,
    );
    // Project-level placement, named per harness (CLAUDE.md / AGENTS.md, §3.2
    // portability); global (config-home) placement is a later knob.
    writeFileSync(join(paths.repoDir, adapter.instructionsFile), readFileSync(src, 'utf8'));
  }

  // Hook scripts land in the config home's hooks/ dir; the settings fragment wires
  // them into the SessionStart/UserPromptSubmit/Stop events via {{HOOKS_DIR}} (§3.2).
  for (const rel of config.install?.hooks ?? []) {
    const src = requirePath(join(configDir, rel), `config "${config.name}" install.hooks entry`);
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(src, join(hooksDir, basename(rel)));
  }

  // A skill dir is copied under the config home's skills/ so Claude Code discovers
  // it in the isolated home and nothing leaks from the operator's own skills (§3.2).
  if (config.install?.skill) {
    const src = requirePath(
      join(configDir, config.install.skill),
      `config "${config.name}" install.skill`,
    );
    const dest = join(paths.ccConfigDir, 'skills', basename(config.install.skill));
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
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

// Replace {{TOKEN}} occurrences in every string of a settings fragment with the
// rep's resolved paths. Post-parse (walking the value) so path characters never
// need JSON-escaping into the fragment source.
function substituteTokens(value: unknown, tokens: Record<string, string>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [token, replacement] of Object.entries(tokens)) {
      out = out.split(token).join(replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => substituteTokens(item, tokens));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteTokens(v, tokens),
      ]),
    );
  }
  return value;
}

function requirePath(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}.`);
  return path;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
