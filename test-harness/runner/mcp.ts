// MCP server list for a rep (harness-spec §7.2 step 2, §3.3). The runner writes
// this JSON and points Claude Code at it with --strict-mcp-config so the sandbox
// sees exactly these servers and nothing from the operator's machine — a leak
// here silently invalidates results (§7.2).
//
// The memento server is launched straight from the repo source (no build step)
// with the rep's MEMENTO_HOME (seeded corpus) and MEMENTO_VARIANT (the config's
// knob bundle) in its env. baseline-no-memento passes `memento: null`, yielding
// an empty server list — Memento is simply absent (§10). The crowded arm adds a
// fixed set of stub servers (§7.3) for deferred-tool discoverability pressure;
// each is the same stub binary under a different profile/server name.

import { join } from 'node:path';

import { CROWDED_PROFILES, getStubProfile } from '../stubs/profiles.js';

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

export interface StubOptions {
  stubsDir: string; // test-harness/stubs — where server.ts lives
}

/** The memento MCP server descriptor: `bun run <repo>/src/main.ts` over stdio. */
export function mementoServer(opts: MementoOptions): McpServerSpec {
  return {
    command: 'bun',
    args: ['run', join(opts.repoRoot, 'src', 'main.ts')],
    env: { MEMENTO_HOME: opts.mementoHome, MEMENTO_VARIANT: opts.variant },
  };
}

/** A stub MCP server descriptor: `bun run <stubs>/server.ts` for one profile. */
export function stubServer(stubsDir: string, profileId: string): McpServerSpec {
  return {
    command: 'bun',
    args: ['run', join(stubsDir, 'server.ts')],
    env: { STUB_PROFILE: profileId },
  };
}

/** Build the full `mcpServers` object for a rep. `memento: null` registers none. */
export function generateMcpConfig(opts: {
  memento: MementoOptions | null;
  env: 'clean' | 'crowded';
  stubs?: StubOptions; // required when env === 'crowded'
}): McpConfig {
  const mcpServers: Record<string, McpServerSpec> = {};
  if (opts.memento) mcpServers.memento = mementoServer(opts.memento);
  if (opts.env === 'crowded') {
    if (!opts.stubs) throw new Error('crowded environment requires stubs.stubsDir.');
    for (const id of CROWDED_PROFILES) {
      mcpServers[getStubProfile(id).server] = stubServer(opts.stubs.stubsDir, id);
    }
  }
  return { mcpServers };
}
