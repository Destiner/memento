#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { Server } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AccountStores } from './accounts.js';
import { createAuthService } from './auth/index.js';
import { loadCloudConfig } from './cloud-config.js';
import { createApplication } from './http.js';
import { importStore } from './import.js';
import { AGENT_FRAGMENT, SERVER_INSTRUCTIONS } from './policy/index.js';
import { acquireServiceLock } from './service-lock.js';

const USAGE =
  'Usage: memento [serve | instructions [--server] | import --source <directory> --account <id>]';

async function main(): Promise<void> {
  process.umask(0o077);
  const [command = 'serve', ...args] = process.argv.slice(2);
  if (command === 'instructions') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--server')) throw new Error(USAGE);
    process.stdout.write(args[0] === '--server' ? `${SERVER_INSTRUCTIONS}\n` : AGENT_FRAGMENT);
    return;
  }
  if (command === 'import') {
    if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--account')
      throw new Error(USAGE);
    const sourceDir = args[1]!;
    const accountId = args[3]!;
    const dataDir = process.env.MEMENTO_DATA_DIR;
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('MEMENTO_DATA_DIR must be absolute.');
    const release = await acquireServiceLock(dataDir);
    try {
      const db = new DatabaseSync(join(dataDir, 'auth.sqlite'), { readOnly: true });
      try {
        const row = db
          .prepare('SELECT id FROM user WHERE id = ? AND emailVerified = 1')
          .get(accountId);
        if (!row) throw new Error('Create the destination account by signing in before importing.');
      } finally {
        db.close();
      }
      const result = await importStore({ sourceDir, dataDir, accountId });
      console.log(
        `Imported ${result.memories} memories and ${result.projects} projects. Source unchanged.`,
      );
    } finally {
      release();
    }
    return;
  }
  if (command !== 'serve' || args.length) throw new Error(USAGE);
  const config = loadCloudConfig();
  const release = await acquireServiceLock(config.dataDir);
  try {
    const auth = await createAuthService(config);
    const accounts = new AccountStores(config.dataDir);
    const application = createApplication({ origin: config.origin, auth, accounts });
    const server = serve({ fetch: application.fetch, hostname: config.host, port: config.port });
    if (server instanceof Server) {
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.keepAliveTimeout = 5_000;
    }
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 25_000);
      deadline.unref();
      const drained = application.drain();
      server.close();
      await drained;
      await accounts.close();
      await auth.close();
      release();
      clearTimeout(deadline);
    };
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void shutdown().catch(() => process.exit(1));
      });
    }
    server.on('error', () => {
      console.error('HTTP listener failed.');
      void shutdown().then(() => {
        process.exitCode = 1;
      });
    });
    console.log('Memento HTTP service ready.');
  } catch (error) {
    release();
    throw error;
  }
}

main().catch(() => {
  // Configuration, provider and filesystem errors can contain secrets or memory content.
  console.error(
    'Memento could not start or complete the command. Check configuration and storage; no sensitive error details were logged.',
  );
  process.exitCode = 1;
});
