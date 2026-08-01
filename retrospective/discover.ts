import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { HistoryClient } from './model.js';
import { stableId } from './adapters/common.js';

export interface HistorySource {
  id: string;
  client: HistoryClient;
  path: string;
}

export interface DiscoveryOptions {
  homeDirectory?: string;
  claudeHistoryRoot?: string;
  codexHistoryRoots?: string[];
}

export interface DiscoveryResult {
  sources: HistorySource[];
  warnings: string[];
}

export async function discoverHistorySources(
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const userHome = resolve(options.homeDirectory ?? homedir());
  const roots: Array<{ client: HistoryClient; path: string }> = [
    {
      client: 'claude-code',
      path: resolve(options.claudeHistoryRoot ?? join(userHome, '.claude', 'projects')),
    },
    ...(
      options.codexHistoryRoots ?? [
        join(userHome, '.codex', 'sessions'),
        join(userHome, '.codex', 'archived_sessions'),
      ]
    ).map((path) => ({ client: 'codex' as const, path: resolve(path) })),
  ];

  const warnings: string[] = [];
  const sources: HistorySource[] = [];
  for (const root of roots) {
    const paths = await walkJsonl(root.path, warnings);
    for (const path of paths) {
      sources.push({
        id: stableId('src', root.client, path),
        client: root.client,
        path,
      });
    }
  }

  sources.sort((left, right) =>
    left.client === right.client
      ? left.path.localeCompare(right.path)
      : left.client.localeCompare(right.client),
  );
  return { sources, warnings };
}

async function walkJsonl(root: string, warnings: string[]): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`Could not inspect history directory ${stableId('path', directory)}`);
      }
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path);
    }
  }

  return output.sort();
}
