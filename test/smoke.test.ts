import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { name, SERVER_VERSION } from '../src/index.js';

test('package exposes its name', () => {
  expect(name).toBe('memento');
});

// The harness pools runs by the package version while the event log and the MCP
// handshake record SERVER_VERSION. If the two drift, pre- and post-change reps
// pool together silently and a comparison quietly stops meaning anything
// (AGENTS.md harness rules).
test('the advertised server version matches package.json', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };

  expect(SERVER_VERSION).toBe(manifest.version);
});
