// Path-safety guards for the canonical store (§15). The memory home is the only
// directory Memento may read or write, and two independent guards enforce it:
//
//   - Memory ids are validated to a safe character set, so a hostile or corrupt
//     id can never smuggle in a path separator or traversal segment.
//   - Every resolved file path is checked to stay within the (symlink-resolved)
//     memory root, so a symlink placed inside memories/ cannot redirect a read
//     outside the store.
//
// Writes are safe by construction: their filenames are built from a validated id
// plus a slugified title (id.ts), neither of which can contain a separator, and
// they land directly in the memory root. The escape vector worth guarding is the
// read side, where an arbitrary on-disk symlink is followed.

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { MementoError } from '../errors.js';

// `mem_` + a sortable suffix (id.ts). We deliberately do not pin the suffix
// length — fixtures and the spec use shorter example ids — only the alphabet, so
// nothing outside [0-9A-Za-z] (no `/`, `\`, `.`, whitespace) can reach the
// filesystem layer.
const MEMORY_ID_PATTERN = /^mem_[0-9A-Za-z]+$/;

// Reject any id that is not a plain `mem_`-prefixed token before it is used to
// match or build a path.
export function assertSafeMemoryId(id: string): void {
  if (!MEMORY_ID_PATTERN.test(id)) {
    throw new MementoError('validation_error', `Invalid memory id: ${JSON.stringify(id)}.`, { id });
  }
}

// Assert that `target` resolves to a location inside `root`. Both are resolved
// through the filesystem (realpath) so a symlink in either cannot redirect the
// result outside the memory root. `target` must already exist — this is the read
// path, where the file was just found via readdir.
export async function assertInsideRoot(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new MementoError(
      'validation_error',
      'Resolved path escapes the memory root and was rejected.',
      { root: realRoot, target: realTarget },
    );
  }
}
