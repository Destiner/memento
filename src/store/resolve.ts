// Resolve a memory's canonical file path from its stable id.
//
// Filenames are `<id>-<slug>.md` (id.ts): the id is authoritative, the slug is
// cosmetic and can drift when a title is edited. So resolution matches on the
// `<id>-` prefix rather than reconstructing the slug. The trailing hyphen keeps
// one id from matching another whose id is a textual prefix of it.
//
// The store is human-editable by design (files are the canonical truth), so a
// renamed file must still resolve: when no filename matches, fall back to
// scanning front matter for the id. Without this, search (indexed from front
// matter) returns ids that read_memory (filename-matched) then reports as
// not_found — agents that did everything right hit a dead end one call after
// a successful search.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoError } from '../errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { assertInsideRoot, assertSafeMemoryId } from './path-safety.js';

// Return the absolute path of the canonical file for `id`. Throws not_found when
// no file matches, internal_error when more than one does (store corruption),
// and validation_error when the id is malformed or the match resolves (via a
// symlink) outside the memory root (§15).
export async function resolveMemoryPath(memoriesDir: string, id: string): Promise<string> {
  assertSafeMemoryId(id);
  let matches = await findMatches(memoriesDir, id);
  if (matches.length === 0) {
    matches = await findByFrontmatterId(memoriesDir, id);
  }
  if (matches.length === 0) {
    throw new MementoError('not_found', `No memory found with id ${id}.`, { id });
  }
  if (matches.length > 1) {
    throw new MementoError('internal_error', `Multiple files found for memory id ${id}.`, {
      id,
      matches,
    });
  }
  const path = join(memoriesDir, matches[0]!);
  await assertInsideRoot(memoriesDir, path);
  return path;
}

async function findMatches(dir: string, id: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const prefix = `${id}-`;
  return entries.filter((name) => name.startsWith(prefix) && name.endsWith('.md'));
}

// Fallback for files whose names drifted from the `<id>-<slug>.md` convention
// (hand-renamed or externally created): match on the front-matter id instead.
// Only runs on a filename miss, so the common path stays a directory listing.
async function findByFrontmatterId(dir: string, id: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const matches: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      const parsed = parseFrontmatter(await readFile(join(dir, name), 'utf8'));
      if (parsed.metadata.id === id) matches.push(name);
    } catch {
      // Unparseable file: not resolvable by id, skip.
    }
  }
  return matches;
}
