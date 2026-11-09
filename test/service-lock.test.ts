import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { acquireServiceLock } from '../src/service-lock.js';

test('serving and import cannot own a data directory simultaneously', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memento-lock-'));
  const release = await acquireServiceLock(dir);
  try {
    await expect(acquireServiceLock(dir)).rejects.toThrow('in use');
    release();
    const next = await acquireServiceLock(dir);
    next();
    next();
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
