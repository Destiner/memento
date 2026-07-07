// Discovery artifact for the write/seed-idempotency scenario (harness-spec §4.3).
// Seeding naively is refused with a shared-database constraint the agent must
// discover to finish. The insight — the shared dev database has no unique
// constraint on users.email, so non-idempotent seeders duplicate rows across every
// service that seeds it — is cross-project context that belongs in memory (§3),
// not this repo's docs.

import { writeFileSync } from 'node:fs';

const key = process.argv.slice(2).find((arg) => arg.startsWith('--idempotency-key='));

if (!key) {
  console.error(
    'seed-users: aborting. This seeder is not idempotent and the shared dev database has no ' +
      'unique constraint on users.email, so re-running duplicates rows across every service ' +
      'that seeds it. Pass --idempotency-key=<run-id> so already-applied runs are skipped.',
  );
  process.exit(1);
}

writeFileSync('.users-seeded', 'ok\n');
console.log('users seeded');
