import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Offline exports only: never infer a live server's storage root or load its config. */
export async function reportSnapshotPaths(argv: string[]): Promise<{
  logs: string;
  memories: string;
  projects: string;
}> {
  if (argv.length !== 2 || argv[0] !== '--snapshot' || !argv[1]?.trim()) {
    throw new Error(
      'Usage: memento report --snapshot <export-directory>. ' +
        'Cloud telemetry reporting is not yet available; provide an explicit offline export containing logs/, memories/, and projects/. No local home fallback is supported.',
    );
  }
  const root = resolve(argv[1]);
  const paths = {
    logs: join(root, 'logs'),
    memories: join(root, 'memories'),
    projects: join(root, 'projects'),
  };
  for (const path of Object.values(paths)) {
    const entry = await stat(path).catch(() => undefined);
    if (!entry?.isDirectory())
      throw new Error('Report snapshot must contain logs/, memories/, and projects/ directories.');
  }
  return paths;
}
