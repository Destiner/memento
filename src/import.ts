import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { DEFAULT_CONFIG, MAX_MEMORY_RETENTION_DAYS } from './config.js';
import { parseFrontmatter } from './store/frontmatter.js';
import { openIndex } from './store/index-open.js';
import { MAX_BODY_LENGTH, validateMemoryFrontmatter } from './store/memory-schema.js';
import { assertSafeProjectId } from './store/path-safety.js';
import { validateProjectFrontmatter } from './store/project-schema.js';

const positive = z.number().int().positive();
const retention = positive.max(MAX_MEMORY_RETENTION_DAYS);
const configSchema = z
  .object({
    schema_version: z.literal(1).optional(),
    search_backend: z.literal('fts5').optional(),
    default_result_limit: positive.optional(),
    max_result_limit: positive.optional(),
    logging_enabled: z.boolean().optional(),
    memory_archive_after_days: retention.optional(),
    memory_delete_after_days: retention.optional(),
  })
  .strict();

/** Offline only: stop the service and other importers; auth-account checks belong to the caller. */
export async function importStore({
  sourceDir,
  dataDir,
  accountId,
}: {
  sourceDir: string;
  dataDir: string;
  accountId: string;
}): Promise<{ memories: number; projects: number }> {
  if (typeof accountId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(accountId)) {
    throw new Error('Invalid account id.');
  }
  for (const value of [sourceDir, dataDir]) {
    if (typeof value !== 'string' || !value.trim())
      throw new Error('Explicit directories are required.');
  }
  const source = resolve(sourceDir);
  const data = resolve(dataDir);
  // Refuse overlap so neither staging nor directory creation can mutate the source.
  if (source === data || source.startsWith(`${data}/`) || data.startsWith(`${source}/`)) {
    throw new Error('Source and destination directories must not overlap.');
  }
  await realDirectoryPath(source, false);
  await rejectSourceLinks(source);
  await realDirectoryPath(data, true);
  const accounts = join(data, 'accounts');
  await realDirectoryPath(accounts, true);
  const destination = join(accounts, accountId);
  await absent(destination);
  const stage = await mkdtemp(join(accounts, '.import-'));
  try {
    await chmod(stage, 0o700);
    const projects = new Set<string>();
    const memories = new Set<string>();
    const references: string[] = [];
    for (const kind of ['projects', 'memories'] as const) {
      const target = join(stage, kind);
      await mkdir(target, { mode: 0o700 });
      const input = join(source, kind);
      if (!(await exists(input))) continue;
      if (!(await lstat(input)).isDirectory()) throw new Error(`Invalid ${kind} directory.`);
      for (const filename of await readdir(input)) {
        const path = join(input, filename);
        if (!filename.endsWith('.md') || filename.includes('\\') || !(await lstat(path)).isFile()) {
          throw new Error(`Unknown or invalid record: ${filename}`);
        }
        const raw = await readFile(path, 'utf8');
        const { metadata, body } = parseFrontmatter(raw);
        if (kind === 'projects') {
          const record = validateProjectFrontmatter(metadata);
          assertSafeProjectId(record.id);
          if (projects.has(record.id)) throw new Error(`Duplicate project id: ${record.id}`);
          projects.add(record.id);
        } else {
          const record = validateMemoryFrontmatter(metadata);
          if (!body || body.length > MAX_BODY_LENGTH)
            throw new Error(`Invalid memory body: ${filename}`);
          if (memories.has(record.id)) throw new Error(`Duplicate memory id: ${record.id}`);
          memories.add(record.id);
          if (record.scope.kind === 'projects') references.push(...record.scope.project_ids);
        }
        await writeFile(join(target, filename), raw, { mode: 0o600, flag: 'wx' });
      }
    }
    for (const id of references) {
      if (!projects.has(id)) throw new Error(`Unknown project reference: ${id}`);
    }
    const config = join(source, 'config.json');
    if (await exists(config)) {
      if (!(await lstat(config)).isFile()) throw new Error('Invalid config file.');
      const raw = await readFile(config, 'utf8');
      const parsed = configSchema.parse(JSON.parse(raw));
      const effective = { ...DEFAULT_CONFIG, ...parsed };
      if (effective.default_result_limit > effective.max_result_limit)
        throw new Error('Invalid config limits.');
      await writeFile(join(stage, 'config.json'), raw, { mode: 0o600, flag: 'wx' });
    }
    await mkdir(join(stage, 'index'), { mode: 0o700 });
    const opened = await openIndex({
      indexDir: join(stage, 'index'),
      memoriesDir: join(stage, 'memories'),
    });
    try {
      if (opened.rebuild?.skipped.length || opened.rebuild?.indexed !== memories.size) {
        throw new Error('Incomplete index rebuild.');
      }
    } finally {
      opened.index.close();
    }
    await rm(join(stage, '.memento-locks'), { recursive: true, force: true });
    for (const file of await readdir(join(stage, 'index')))
      await chmod(join(stage, 'index', file), 0o600);
    await absent(destination);
    await rename(stage, destination);
    return { memories: memories.size, projects: projects.size };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function absent(path: string): Promise<void> {
  if (await exists(path))
    throw new Error('Destination already exists; refusing to merge or overwrite.');
}

async function realDirectoryPath(path: string, create: boolean): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await realDirectoryPath(parent, create);
  if (create && !(await exists(path))) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Not a real directory: ${path}`);
}

async function rejectSourceLinks(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${path}`);
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await rejectSourceLinks(join(path, name));
  }
}
