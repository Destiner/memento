// The read_memory operation (§9.4): return a single memory's full file text
// plus a small typed metadata summary, resolved by stable id.
//
// The returned `markdown` is the canonical file verbatim (front matter + body).
// Front matter is still parsed and validated so a hand-edited or corrupted file
// surfaces an error rather than a partial read, and so the summary fields are
// trustworthy.

import { readFile } from 'node:fs/promises';

import { validate } from '../validation.js';
import { parseFrontmatter } from './frontmatter.js';
import { resolveMemoryPath } from './resolve.js';
import { readMemoryInputSchema, validateFrontmatter, type MemoryMetadata } from './schema.js';

export interface ReadMemoryOptions {
  memoriesDir: string;
}

export interface ReadMemoryResult {
  id: string;
  metadata: Pick<MemoryMetadata, 'title' | 'type' | 'scope' | 'status'>;
  markdown: string;
}

export async function readMemory(
  rawInput: unknown,
  options: ReadMemoryOptions,
): Promise<ReadMemoryResult> {
  const input = validate(readMemoryInputSchema, rawInput);

  const path = await resolveMemoryPath(options.memoriesDir, input.id);
  const markdown = await readFile(path, 'utf8');
  const { metadata } = parseFrontmatter(markdown);
  const validated = validateFrontmatter(metadata);

  return {
    id: validated.id,
    metadata: {
      title: validated.title,
      type: validated.type,
      scope: validated.scope,
      status: validated.status,
    },
    markdown,
  };
}
