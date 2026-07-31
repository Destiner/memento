import { writeFileSync } from 'node:fs';

import { demoWelcome } from '../src/notify.js';
import { enqueueBatch, setTransport, type Job } from '../src/queue.js';

// Local stand-in for the shared notification broker, mirroring production
// behavior exactly: publishes are accepted per batch, subject to broker policy.
setTransport(async (jobs: Job[]) => {
  if (jobs.length > 25) {
    throw new Error(
      `broker refused batch of ${jobs.length}: org-wide policy caps notification ` +
        'batches at 25 per publish (shared broker; applies to every service)',
    );
  }
});

const jobs = Array.from({ length: 100 }, (_, i) => demoWelcome(`usr_demo_${i + 1}`, i + 1));
await enqueueBatch(jobs);
writeFileSync('.seed-complete', `${jobs.length}\n`);
console.log(`seeded ${jobs.length} demo notifications`);
