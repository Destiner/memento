#!/usr/bin/env node
// Operator report server (§13): reads the local event logs and serves the usage
// dashboard on a random free port. This is NOT part of the MCP surface — it is a
// human-facing admin tool run on demand (`bun run report`).
//
// The metrics are recomputed on every request, so refreshing the page picks up
// events written since it started. Binds to loopback only; logs never leave the
// machine.

import { createServer } from 'node:http';

import { loadConfig } from '../config.js';
import { isoSeconds } from '../store/time.js';
import { renderReport } from './html.js';
import { loadEvents } from './load.js';
import { computeMetrics } from './metrics.js';

async function main(): Promise<void> {
  const { paths } = loadConfig();

  const server = createServer((req, res) => {
    if (req.url && req.url !== '/') {
      res.writeHead(404).end('Not found');
      return;
    }
    void (async () => {
      try {
        const events = await loadEvents(paths.logs);
        const metrics = computeMetrics(events);
        const html = renderReport(metrics, {
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
    console.log(`Memento usage report → http://127.0.0.1:${port}  (reading ${paths.logs})`);
    console.log('Press Ctrl+C to stop.');
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
