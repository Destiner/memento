import { lstat, mkdir, writeFile } from 'node:fs/promises';
import type {
  DurableObjectNamespace,
  DurableObjectState,
  Request,
} from '@cloudflare/workers-types';

import {
  readAccountDocuments,
  replaceEmptyAccountDocuments,
  withAccountStore,
  type AccountDocument,
} from '../cloudflare/account-store.js';
import { createLogger } from '../src/logging/logger.js';
import { archiveMemory } from '../src/store/memory-archive.js';
import { createMemory } from '../src/store/memory-create.js';
import { decayMemories } from '../src/store/memory-decay.js';
import { getMemory } from '../src/store/memory-get.js';
import { searchMemories } from '../src/store/memory-search.js';
import { updateMemory } from '../src/store/memory-update.js';
import { createProject } from '../src/store/project-create.js';
import { resolveProject } from '../src/store/project-resolve.js';
import { updateProject } from '../src/store/project-update.js';

const STALE_ID = 'c14367b0-a08e-40f8-99e3-e2f7171e886d';
const STALE_DIR = `/tmp/memento-account-${STALE_ID}`;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class TestAccount {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { storage } = this.state;
    // Every input to this fixture is synthetic, including the fault injection routes.
    const { action, args, now } = (await request.json()) as {
      action: string;
      args?: unknown;
      now?: number;
    };
    try {
      if (action === 'documents') return Response.json(readAccountDocuments(storage));
      if (action === 'import') {
        await replaceEmptyAccountDocuments(storage, args as AccountDocument[]);
        return Response.json(true);
      }
      if (action === 'logs') {
        return Response.json(
          storage.sql
            .exec<{ line: string }>('SELECT line FROM account_tool_events ORDER BY sequence')
            .toArray()
            .map(({ line }) => JSON.parse(line)),
        );
      }
      if (action === 'stageStaleScratch') {
        await mkdir(STALE_DIR);
        await writeFile(`${STALE_DIR}/leftover`, 'synthetic');
        storage.sql.exec('UPDATE account_store_state SET scratch_id = ?', STALE_ID);
        await storage.sync();
        return Response.json(await exists(STALE_DIR));
      }
      if (action === 'dropSearchIndex' || action === 'oldSearchSchema') {
        if (action === 'dropSearchIndex') {
          storage.sql.exec('DROP TABLE memories_fts');
        } else {
          storage.sql.exec('DROP TABLE memories; CREATE TABLE memories (id TEXT PRIMARY KEY);');
          storage.sql.exec('UPDATE account_store_state SET clean_index_version = 1');
        }
        await storage.sync();
        return Response.json(true);
      }
      if (action === 'rejectEventCommit') {
        storage.sql.exec(`
          CREATE TRIGGER reject_event BEFORE INSERT ON account_tool_events
          BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END;
        `);
      }
      let home = '';
      const result = await withAccountStore(storage, async (store) => {
        const { paths, config } = store.resolved;
        const { index } = store;
        home = paths.home;
        const options = { memoriesDir: paths.memories, projectsDir: paths.projects, index, now };
        return store
          .enqueue(async () => {
            switch (action) {
              case 'createProject':
                return createProject(args, options);
              case 'updateProject':
                return updateProject(args, options);
              case 'resolveProject':
                return resolveProject(args, options);
              case 'createMemory':
                return createMemory(args, options);
              case 'updateMemory':
                return updateMemory(args, options);
              case 'getMemory':
                return getMemory(args, options);
              case 'archiveMemory':
                return archiveMemory(args, options);
              case 'decay':
                return decayMemories({ ...options, config });
              case 'search':
                return searchMemories(args, {
                  ...options,
                  defaultLimit: config.default_result_limit,
                  maxLimit: config.max_result_limit,
                });
              case 'config':
                return config;
              case 'failAfterCreate':
                await createMemory(args, options);
                throw new Error('Synthetic interruption after write and index update.');
              case 'overLimit':
                await createMemory(args, options);
                await writeFile(`${paths.projects}/oversize.md`, '.'.repeat(256 * 1024 + 1));
                return true;
              case 'scratch':
                return !(await exists(STALE_DIR));
              case 'rejectEventCommit':
              case 'logBatch': {
                const logger = createLogger({
                  logsDir: paths.logs,
                  enabled: config.logging_enabled,
                  serverVersion: 'test',
                  policyVersion: 'test',
                  variant: 'test',
                  sessionId: 'test',
                  client: () => ({ name: String(args) }),
                });
                if (action === 'rejectEventCommit') {
                  const created = await createMemory(args, options);
                  await logger.log({ tool: 'create_memory', outcome: 'success', latency_ms: 1 });
                  return created;
                }
                for (let i = 0; i < 40; i++) {
                  void logger.log({ tool: 'get_memory', outcome: 'success', latency_ms: 1 });
                }
                return true;
              }
              default:
                throw new Error('Unknown fixture operation.');
            }
          })
          .catch((error: Error) => {
            if (action !== 'caughtToolError') throw error;
            index.clear();
            return false;
          });
      });
      if (await exists(home)) throw new Error('Request scratch was not removed.');
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    } finally {
      if (action === 'rejectEventCommit') storage.sql.exec('DROP TRIGGER IF EXISTS reject_event');
    }
  }
}

export default {
  fetch(request: Request, env: { ACCOUNT: DurableObjectNamespace }) {
    const account = new URL(request.url).pathname.slice(1);
    return env.ACCOUNT.get(env.ACCOUNT.idFromName(account)).fetch(request);
  },
};
