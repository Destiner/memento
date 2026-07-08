# overlays

Operator reference for the fixture overlays (harness-spec §4.3). An overlay is a
small directory copied on top of a fixture *after* checkout to stage a scenario's
baseline, then folded into the baseline commit so it never shows up in the session
diff the scorer reads (`runner/sandbox.ts`).

> **This file lives at `overlays/README.md`, not inside an overlay dir, on
> purpose.** The runner copies an overlay directory *verbatim* into the repo the
> agent explores (`overlayOnto`, `runner/sandbox.ts`). Anything inside an overlay
> dir — including a README — reaches the agent. Ground-truth answers, rubric
> hints, and any "this is being scored" signal must stay out here, or the write
> side measures prompt leakage instead of the knob under test.

## `saas-app-mailer`

Greens `fixtures/saas-app` for the should-not-\* and read scenarios that need the
email path wired up: `src/email.ts` + `src/auth/password-reset.ts` implement a
dev mailer so `bun run check` passes at baseline, and a should-not-edit stays
green. No discovery artifacts.

## `saas-app-ops`

Stages the should-capture (`write/*`) scenarios. Two roles:

- **Greens the app.** `src/email.ts` + `src/auth/password-reset.ts` mirror the
  `saas-app-mailer` overlay so `bun run check` passes at baseline — the capture
  `task_success` guardrail then measures only whether the discovery task got
  done, not the pre-existing unimplemented email path.
- **Plants discovery artifacts.** `scripts/*.ts` each refuse a naive invocation
  with a message stating a *cross-service* constraint, and succeed (writing a
  marker the scenario's `task_success` checks) once the agent discovers the
  workaround. The durable, cross-project insight in that message — not the flag
  itself — is what a good capture records (§5.2 rubric).

| Script                       | Scenario                     | Insight (belongs in memory, §3)                                              |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `scripts/migrate.ts`         | `write/migrate-single-tx`    | Concurrent migrations corrupt the shared Postgres ledger; use `--single-tx`. |
| `scripts/send-test-email.ts` | `write/email-sandbox-stream` | The shared Postmark sandbox account has only the `outbound` stream active.   |
| `scripts/seed-users.ts`      | `write/seed-idempotency`     | The shared dev DB has no unique `users.email`; seeders need an idempotency key. |

`scripts/` sits outside the fixture's `tsconfig` `include` (`src` only), so the
scripts don't affect `bun run check`; they're run directly with `bun`.
