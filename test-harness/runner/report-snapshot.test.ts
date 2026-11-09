import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reportSnapshotPaths } from '../../src/report/snapshot.js';

it('rejects implicit live-home reporting', async () => {
  await expect(reportSnapshotPaths([])).rejects.toThrow(/--snapshot/);
  await expect(reportSnapshotPaths(['--home', '/private/live'])).rejects.toThrow(
    /No local home fallback/,
  );
});

it('requires a complete explicit offline snapshot and creates nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memento-report-snapshot-'));
  try {
    await expect(reportSnapshotPaths(['--snapshot', root])).rejects.toThrow(/must contain/);
    expect(await readdir(root)).toEqual([]);
    for (const directory of ['logs', 'memories', 'projects']) await mkdir(join(root, directory));
    expect(await reportSnapshotPaths(['--snapshot', root])).toEqual({
      logs: join(root, 'logs'),
      memories: join(root, 'memories'),
      projects: join(root, 'projects'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
