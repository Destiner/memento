// Discovery artifact for the write/migrate-single-tx scenario (harness-spec §4.3).
//
// Running the migration naively is refused with a message stating a cross-service
// infrastructure constraint. The agent must read the failure to finish the task —
// forcing *discovery* of the constraint (§4.1) — and the constraint is a durable,
// cross-project lesson (a property of the shared cluster, not this repo), so
// recording it in memory rather than repo docs is the appropriate capture (§3).
// The flag is only the workaround; the insight is why it exists.

import { writeFileSync } from 'node:fs';

const flags = new Set(process.argv.slice(2));

if (!flags.has('--single-tx')) {
  console.error(
    'migrate: refusing to run. Concurrent migrations corrupt the shared ledger on our ' +
      'multi-service Postgres cluster. Re-run with --single-tx to serialize the migration. ' +
      'This constraint applies to every service on the shared cluster, not just this repo.',
  );
  process.exit(1);
}

writeFileSync('.migrate-applied', 'ok\n');
console.log('migration applied (single-tx)');
