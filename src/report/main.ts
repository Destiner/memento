#!/usr/bin/env node
// Offline snapshot report; never reads an implicit production/local memory home.
// Binds to loopback only and does not mutate the supplied export.

import { createServer } from 'node:http';

import { reportSnapshotPaths } from './snapshot.js';
import { isoSeconds } from '../store/time.js';
import { renderReport } from './html.js';
import { loadEvents } from './load.js';
import { computeMetrics } from './metrics.js';
import { loadStoreView } from './store-view.js';

async function main(): Promise<void> {
  const paths = await reportSnapshotPaths(process.argv.slice(2));

  const server = createServer((req, res) => {
    if (req.url && req.url !== '/') {
      res.writeHead(404).end('Not found');
      return;
    }
    void (async () => {
      try {
        const events = await loadEvents(paths.logs);
        const metrics = computeMetrics(events);
        const store = await loadStoreView(metrics, {
          memoriesDir: paths.memories,
          projectsDir: paths.projects,
        });
        const html = renderReport(metrics, store, {
          generatedAt: isoSeconds(Date.now()),
          logsDir: paths.logs,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
      }
    })();
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    console.log(
      `Memento offline snapshot report → http://127.0.0.1:${port}  (reading ${paths.logs})`,
    );
    console.log('Press Ctrl+C to stop.');
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
