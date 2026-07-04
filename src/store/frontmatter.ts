// YAML front-matter parsing and serialization for canonical memory files.
//
// A memory file is a YAML mapping delimited by `---` lines, followed by the
// markdown body. This module is deliberately schema-agnostic: it moves data
// between raw file text and a `{ metadata, body }` pair. Vocabulary validation
// lives in the schema module; callers build metadata in canonical field order,
// which `yaml` preserves so output stays deterministic.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { MementoError } from '../errors.js';

export interface ParsedMemory {
  metadata: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

// Split a raw memory file into its front-matter mapping and markdown body.
// A missing or non-mapping front-matter block indicates store corruption.
export function parseFrontmatter(raw: string): ParsedMemory {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new MementoError('internal_error', 'Memory file is missing a YAML front-matter block.');
  }
  const yamlBlock = match[1] ?? '';

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (error) {
    throw new MementoError(
      'internal_error',
      `Memory front matter is not valid YAML: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MementoError('internal_error', 'Memory front matter must be a YAML mapping.');
  }

  return {
    metadata: parsed as Record<string, unknown>,
    body: raw.slice(match[0].length).trim(),
  };
}

// Render metadata and body back into canonical file text. Body is normalized
// so that parse/serialize round-trips are idempotent.
export function serializeFrontmatter(metadata: Record<string, unknown>, body: string): string {
  const yamlBlock = stringifyYaml(metadata).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${body.trim()}\n`;
}
