#!/usr/bin/env bun
// Harness runner entrypoint (harness-spec §8.1).
//
//   bun run harness -- manifests/<name>.yaml
//
// Executes a run manifest: the hermetic per-rep lifecycle (§7.2), scoring (§5),
// and JSONL persistence (§8.2). Those land in later build-order steps (§11.3–5);
// this scaffold wires the invocation and manifest resolution only.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function main(argv: string[]): void {
  const manifestPath = argv[0];
  if (!manifestPath) {
    console.error('Usage: bun run harness -- <manifest.yaml>');
    process.exit(1);
  }

  const resolved = resolve(manifestPath);
  if (!existsSync(resolved)) {
    console.error(`Manifest not found: ${resolved}`);
    process.exit(1);
  }

  console.error(`Resolved manifest: ${resolved}`);
  console.error('Runner not yet implemented (harness-spec §11 steps 3–5).');
  process.exit(0);
}

main(process.argv.slice(2));
