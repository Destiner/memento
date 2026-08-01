#!/usr/bin/env node
// Launches the Memento MCP server over stdio, or prints an instruction surface.
//
// `memento instructions` exists so the AGENTS.md / CLAUDE.md fragment has exactly
// one home (src/policy) instead of a checked-in copy that drifts from it. An
// unrecognised argument fails loudly: a stdio server started by mistake looks like
// a hang, which is a worse way to learn about a typo.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AGENT_FRAGMENT, SERVER_INSTRUCTIONS } from './policy/index.js';
import { createServer } from './server.js';

const USAGE = 'Usage: memento [instructions [--server]]';

// A CLI mistake is not a crash: message only, no stack.
function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'instructions') {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--server')) {
      return fail(`Unexpected arguments: ${rest.join(' ')}`);
    }
    const surface = rest[0] === '--server' ? `${SERVER_INSTRUCTIONS}\n` : AGENT_FRAGMENT;
    process.stdout.write(surface);
    return;
  }
  if (command !== undefined) {
    return fail(`Unknown argument "${command}".`);
  }

  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
