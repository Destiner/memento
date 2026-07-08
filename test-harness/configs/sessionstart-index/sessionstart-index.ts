#!/usr/bin/env bun
// SessionStart hook for the sessionstart-index knob (harness-spec §3.2). It reads
// the seeded memory titles from $MEMENTO_HOME/memories and injects them as
// SessionStart additionalContext, so the agent starts the session already knowing
// what memory holds — the "memory index (titles)" variant of the SessionStart hook.
//
// Self-contained on purpose: it is launched standalone by Claude Code (`bun run`),
// not imported into the runner, and reads only the per-rep MEMENTO_HOME the sandbox
// passes in via the settings fragment. Lenient — a missing home or malformed file
// yields no context rather than failing the session.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function memoryTitles(memoriesDir: string): string[] {
  if (!existsSync(memoriesDir)) return [];
  const titles: string[] = [];
  for (const name of readdirSync(memoriesDir).sort()) {
    if (!name.endsWith('.md')) continue;
    try {
      const title = titleOf(readFileSync(join(memoriesDir, name), 'utf8'));
      if (title) titles.push(title);
    } catch {
      // Skip an unreadable file; the index is best-effort context, not a gate.
    }
  }
  return titles;
}

// Pull `title:` from the leading YAML front-matter block, trimming quotes.
function titleOf(content: string): string | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const line = /^title:\s*(.+?)\s*$/m.exec(match[1]!);
  if (!line) return null;
  return line[1]!.replace(/^["']|["']$/g, '');
}

function main(): void {
  const home = process.env.MEMENTO_HOME?.trim();
  if (!home) return;
  const titles = memoryTitles(join(home, 'memories'));
  if (titles.length === 0) return;

  const additionalContext = [
    'Memento holds the following memories (titles only — search Memento to read one):',
    ...titles.map((t) => `- ${t}`),
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }) + '\n',
  );
}

main();
