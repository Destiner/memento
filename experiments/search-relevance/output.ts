import assert from 'node:assert/strict';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function assertPrivateOutput(path: string): Promise<string> {
  const target = resolve(await realpath(dirname(resolve(path))), basename(path));
  const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const rel = relative(repo, target);
  assert(rel.startsWith(`..${sep}`) || isAbsolute(rel), 'Output must be outside the repository');
  return target;
}

// Exclusive creation refuses symlinks and accidental evidence/seed overwrites.
export async function writePrivateOutput(path: string, content: string): Promise<void> {
  const target = await assertPrivateOutput(path);
  const file = await open(target, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
