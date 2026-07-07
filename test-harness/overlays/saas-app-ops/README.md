# overlay: saas-app-ops

Stages the should-capture (`write/*`) scenarios on `fixtures/saas-app`
(harness-spec §4.3). Two roles:

- **Greens the app.** `src/email.ts` + `src/auth/password-reset.ts` mirror the
  `saas-app-mailer` overlay so `bun run check` passes at baseline — the capture
  `task_success` guardrail then measures only whether the discovery task got
  done, not the pre-existing unimplemented email path.
- **Plants discovery artifacts.** `scripts/*.ts` each refuse a naive invocation
  with a message stating a *cross-service* constraint, and succeed (writing a
  marker the scenario's `task_success` checks) once the agent discovers the
  workaround. The durable, cross-project insight in that message — not the flag
  itself — is what a good capture records (§5.2 rubric).

| Script                  | Scenario                   | Insight (belongs in memory, §3)                                   |
| ----------------------- | -------------------------- | ---------------------------------------------------------------- |
| `scripts/migrate.ts`         | `write/migrate-single-tx`  | Concurrent migrations corrupt the shared Postgres ledger; use `--single-tx`. |
| `scripts/send-test-email.ts` | `write/email-sandbox-stream` | The shared Postmark sandbox account has only the `outbound` stream active. |
| `scripts/seed-users.ts`      | `write/seed-idempotency`   | The shared dev DB has no unique `users.email`; seeders need an idempotency key. |

`scripts/` sits outside the fixture's `tsconfig` `include` (`src` only), so the
scripts don't affect `bun run check`; they're run directly with `bun`.
