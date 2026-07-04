// Resolve a memory's canonical file path from its stable id.
//
// Filenames are `<id>-<slug>.md` (id.ts): the id is authoritative, the slug is
// cosmetic and can drift when a title is edited. So resolution matches on the
// `<id>-` prefix rather than reconstructing the slug. The trailing hyphen keeps
// one id from matching another whose id is a textual prefix of it.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoError } from '../errors.js';

// Return the absolute path of the canonical file for `id`. Throws not_found when
// no file matches and internal_error when more than one does (store corruption).
export async function resolveMemoryPath(memoriesDir: string, id: string): Promise<string> {
  const matches = await findMatches(memoriesDir, id);
  if (matches.length === 0) {
    throw new MementoError('not_found', `No memory found with id ${id}.`, { id });
  }
  if (matches.length > 1) {
    throw new MementoError('internal_error', `Multiple files found for memory id ${id}.`, {
      id,
      matches,
    });
  }
  return join(memoriesDir, matches[0]!);
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
