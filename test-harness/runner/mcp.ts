// MCP server list for a rep (harness-spec §7.2 step 2, §3.3). The runner writes
// this JSON and points Claude Code at it with --strict-mcp-config so the sandbox
// sees exactly these servers and nothing from the operator's machine — a leak
// here silently invalidates results (§7.2).
//
// The memento server is launched straight from the repo source (no build step)
// with the rep's MEMENTO_HOME (seeded corpus) and MEMENTO_VARIANT (the config's
// knob bundle) in its env. baseline-no-memento passes `memento: null`, yielding
// an empty server list — Memento is simply absent (§10). The crowded arm adds
// fixed stub servers (§7.3); those land with the stub server in a later step
// (§11 step 6), so requesting `crowded` throws until then rather than silently
// running clean.

import { join } from 'node:path';

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerSpec>;
}

export interface MementoOptions {
  repoRoot: string; // Memento checkout the server is launched from
  mementoHome: string; // seeded MEMENTO_HOME for this rep
  variant: string; // MEMENTO_VARIANT (the config's knob bundle)
}

/** The memento MCP server descriptor: `bun run <repo>/src/main.ts` over stdio. */
export function mementoServer(opts: MementoOptions): McpServerSpec {
  return {
    command: 'bun',
    args: ['run', join(opts.repoRoot, 'src', 'main.ts')],
    env: { MEMENTO_HOME: opts.mementoHome, MEMENTO_VARIANT: opts.variant },
  };
}

/** Build the full `mcpServers` object for a rep. `memento: null` registers none. */
export function generateMcpConfig(opts: {
  memento: MementoOptions | null;
  env: 'clean' | 'crowded';
}): McpConfig {
  if (opts.env === 'crowded') {
    throw new Error(
      'crowded environment is not yet implemented (stub MCP server is harness-spec §11 step 6).',
    );
  }
  const mcpServers: Record<string, McpServerSpec> = {};
  if (opts.memento) mcpServers.memento = mementoServer(opts.memento);
  return { mcpServers };
}
