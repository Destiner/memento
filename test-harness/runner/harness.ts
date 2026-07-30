// Harness adapters (harness-spec §7.2): everything that differs between coding
// agents lives behind this seam — invocation shape, result parsing, config-home
// layout, MCP registration, and instructions-file naming. Scenarios, corpus,
// scoring, and the scheduler never see the harness.
//
// claude-code: `claude -p` with an isolated CLAUDE_CONFIG_DIR, JSON result
// object, --mcp-config registration, CLAUDE.md instructions, hooks + settings.
//
// codex: `codex exec --json` with an isolated CODEX_HOME, JSONL events,
// [mcp_servers] tables in config.toml, AGENTS.md instructions, no hooks or
// settings (plan.ts rejects configs that need them, §3.2 portability). Codex
// reports token usage but no dollar cost, so `costReported` is false and every
// rep charges the conservative fallback to the spend cap — a codex cap is
// effectively a rep-count cap (§7.4).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type McpConfig, type McpServerSpec } from './mcp.js';
import {
  buildClaudeInvocation,
  parseSessionResult,
  type Invocation,
  type SessionResult,
} from './session.js';

export const HARNESSES = ['claude-code', 'codex'] as const;
export type HarnessName = (typeof HARNESSES)[number];

export interface HarnessInvocationInput {
  repoDir: string; // cwd for the session
  configHome: string; // CLAUDE_CONFIG_DIR / CODEX_HOME
  mcpConfigPath: string; // where writeMcpRegistration put the server list
  task: string;
  model: string;
}

export interface HarnessAdapter {
  name: HarnessName;
  /** Filename the `claude_md` install artifact lands as (§3.2 portability). */
  instructionsFile: 'CLAUDE.md' | 'AGENTS.md';
  supportsHooks: boolean;
  supportsSettings: boolean;
  /** Whether sessions report a dollar cost (gates the §7.4 cost-drift warning). */
  costReported: boolean;
  detectVersion(): string;
  /** Register MCP servers for a rep; returns the path recorded as mcpConfigPath. */
  writeMcpRegistration(paths: { root: string; configHome: string }, mcp: McpConfig): string;
  buildInvocation(input: HarnessInvocationInput): Invocation;
  parseResult(stdout: string): SessionResult;
}

export function makeAdapter(name: HarnessName): HarnessAdapter {
  return name === 'codex' ? codexAdapter : claudeCodeAdapter;
}

const claudeCodeAdapter: HarnessAdapter = {
  name: 'claude-code',
  instructionsFile: 'CLAUDE.md',
  supportsHooks: true,
  supportsSettings: true,
  costReported: true,
  detectVersion: () => versionOf('claude'),
  writeMcpRegistration({ root }, mcp) {
    const path = join(root, 'mcp.json');
    writeFileSync(path, JSON.stringify(mcp, null, 2) + '\n');
    return path;
  },
  buildInvocation: (input) =>
    buildClaudeInvocation({
      repoDir: input.repoDir,
      ccConfigDir: input.configHome,
      mcpConfigPath: input.mcpConfigPath,
      task: input.task,
      model: input.model,
    }),
  parseResult: parseSessionResult,
};

const codexAdapter: HarnessAdapter = {
  name: 'codex',
  instructionsFile: 'AGENTS.md',
  supportsHooks: false,
  supportsSettings: false,
  costReported: false,
  detectVersion: () => versionOf('codex'),
  // Codex reads MCP servers from config.toml inside CODEX_HOME. Auth is a plain
  // file there too (unlike Claude Code's Keychain), so hermetic isolation just
  // copies the operator's auth.json into the throwaway home.
  writeMcpRegistration({ configHome }, mcp) {
    const auth = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(auth)) {
      throw new Error(`Codex auth not found at ${auth} — run \`codex login\` once, then retry.`);
    }
    copyFileSync(auth, join(configHome, 'auth.json'));
    const path = join(configHome, 'config.toml');
    writeFileSync(path, mcpConfigToToml(mcp));
    return path;
  },
  buildInvocation: (input) => ({
    command: 'codex',
    args: [
      'exec',
      '--json',
      '-m',
      input.model,
      '-s',
      'workspace-write',
      '--skip-git-repo-check',
      input.task,
    ],
    env: { ...process.env, CODEX_HOME: input.configHome },
    cwd: input.repoDir,
  }),
  parseResult: parseCodexResult,
};

/** Serialize an MCP server list as codex config.toml `[mcp_servers.*]` tables. */
export function mcpConfigToToml(mcp: McpConfig): string {
  const blocks = Object.entries(mcp.mcpServers).map(([name, spec]) => serverBlock(name, spec));
  return blocks.join('\n');
}

function serverBlock(name: string, spec: McpServerSpec): string {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
  ];
  const env = Object.entries(spec.env ?? {});
  if (env.length > 0) {
    lines.push(`env = { ${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`);
  }
  return lines.join('\n') + '\n';
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Parse `codex exec --json` JSONL events into the shared SessionResult shape.
 * Token usage accumulates across `turn.completed` events; the last agent_message
 * is the result text; no dollar cost is reported (costUsd stays null). Lenient
 * like the claude parser: garbage in → parsed:false → invalid rep (§7.4).
 */
export function parseCodexResult(stdout: string): SessionResult {
  let sawEvent = false;
  let sawError = false;
  let turns = 0;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let sessionId: string | null = null;
  let resultText: string | null = null;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue; // codex may interleave non-JSON diagnostics; skip them
    }
    sawEvent = true;
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
    } else if (type === 'turn.completed') {
      turns += 1;
      const usage = isObject(event.usage) ? event.usage : {};
      // output_tokens already includes reasoning_output_tokens; do not double-count.
      tokensIn =
        (tokensIn ?? 0) +
        (num(usage.input_tokens) ?? 0) +
        (num(usage.cached_input_tokens) ?? 0) +
        (num(usage.cache_write_input_tokens) ?? 0);
      tokensOut = (tokensOut ?? 0) + (num(usage.output_tokens) ?? 0);
    } else if (type === 'turn.failed' || type === 'error') {
      sawError = true;
    } else if (type === 'item.completed') {
      const item = isObject(event.item) ? event.item : {};
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        resultText = item.text;
      }
    }
  }

  if (!sawEvent) {
    return {
      parsed: false,
      isError: true,
      costUsd: null,
      durationS: null,
      turns: null,
      tokensIn: null,
      tokensOut: null,
      sessionId: null,
      resultText: null,
    };
  }
  return {
    parsed: true,
    // A stream with no final agent message means the session died mid-turn.
    isError: sawError || resultText === null,
    costUsd: null,
    durationS: null,
    turns: turns || null,
    tokensIn,
    tokensOut,
    sessionId,
    resultText,
  };
}

function versionOf(command: string): string {
  const raw = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  return /\d+\.\d+\.\d+/.exec(raw)?.[0] ?? raw;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
