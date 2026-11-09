# Memento

Cloud-only, account-isolated memory layer for coding agents, exposed over authenticated HTTP MCP.

## Commands

- `bun install` - Install dependencies
- `bun run build` - Compile TypeScript to `dist/`
- `bun run typecheck` - Type-check without emitting
- `bun run lint` - ESLint
- `bun run format` - Prettier (writes; skips `*.md` per `.prettierignore`)
- `bun run test` - Run the Vitest suite
- `bunx vitest run test/foo.test.ts` - Run a single test file
- `bun run typecheck:harness` / `bun run test:harness` - Same for the test harness
- `bun run check` - Lint, format check, all typechecks/tests, production build
- `bun run start` - Start the Node HTTP service with explicit private environment configuration
- Paid harness execution is disabled pending authenticated remote fixture lifecycle; offline tests/reports remain available.
- `bun run harness:report` - Score and render all results
- `bun run retrospective -- help` - Offline history evaluation/review/export; project resolution is remote, promotion/reconciliation currently unavailable
- `bun run typecheck:retrospective` / `bun run test:retrospective` - Check the isolated retrospective package

## Stack

- Language: TypeScript (ESM, `NodeNext`), runtime Node >=22.16, managed with Bun
- Protocol: stateless Streamable HTTP MCP via `@modelcontextprotocol/sdk`, Hono/Node HTTP
- Auth: Better Auth + OAuth provider, `node:sqlite`; private `AUTH_ALLOWED_EMAILS` admission
- Store: markdown files (YAML front matter) + SQLite FTS5 search index via `node:sqlite`, whose bundled FTS5 support requires the tested Node floor of 22.16
- Test runner: Vitest

## Structure

- `/src` - HTTP service, tools, account stores; `/src/auth` owns OAuth/social login
- `docs/deployment.md` - Render setup, auth boundary, one-way import and operating constraints
- `/src/policy` - The instruction surfaces, assembled from `docs/memory-policy.md` as data (`blocks.ts`): server instructions, the AGENTS.md fragment, and both tool-description sets. Print either prose surface with `memento instructions [--server]`
- `/src/variants` - `MEMENTO_VARIANT` registry: context-engineering knob bundles (descriptions/instructions/nudges); `shipped-v2` is the production default, `plain` is the experimental floor
- `/test` - Vitest specs and fixtures
- `/test-harness` - Usage-propensity experiment harness (see `docs/harness-spec.md`): runner, scenarios, fixtures, manifests, results
- `/retrospective` - Offline Claude Code/Codex history evaluation, review, promotion, and regression export (see `docs/retrospection.md`)
- `docs/memory-policy.md` - Canonical memory policy and vocabulary (types, scopes, provenance). Every instruction surface derives from it; edit it before `/src/policy`, and bump `policy_version` for any change to §2-§10

## Patterns

- Public repository: never commit real allowlist emails, credentials, tokens, private exports or environment files. Use environment-only secrets and synthetic test identities.
- One Render process/disk, no local product mode or sync. Resolve storage only from verified account identity; recheck bearer authority per request and before queued tool dispatch. Browser sessions do not authenticate MCP.
- Disk is runtime-only: initialize auth before readiness, never in build/predeploy. Serving/import share an exclusive runtime lock. See `docs/deployment.md` before infrastructure changes.
- Keep docs focused on current behavior and operating constraints, not historical reports or completed plans. Retain evaluation data only when it serves ongoing tests.
- Markdown files are the authoritative store; the SQLite index is derived and must be rebuildable from `memories/*.md`.
- The store is human-editable: nothing may assume filenames follow the `<id>-slug.md` convention (`get_memory` falls back to front-matter ids — a renamed file must keep working).
- The server CANNOT run under `bun run` (`node:sqlite` is not implemented in Bun); it runs under Node (`node dist/main.js`). Tests pass under `bun run test` only because vitest itself runs on Node.
- Retrospective measurement changes must bump `RETROSPECTIVE_PIPELINE_VERSION`; prompt-only changes also bump the affected prompt version, and output-shape changes bump `EVALUATOR_SCHEMA_VERSION`.

## Harness rules (read `docs/harness-spec.md` before touching experiments)

- Results are append-only in `test-harness/results/results.jsonl`; invalidated runs move to `quarantine-*.jsonl`, never deleted. Scores are always recomputed from the log.
- Comparisons are only valid within one (harness, model, cc_version, memento_version, env) tuple. Bump the package version for any measurement-relevant server change.
- Any new or edited scenario bumps its `version` and MUST pass a baseline-no-memento calibration (utility ≈ 0) before use.
- Existing `holdout-*` scenario groups are regression data, not untouched holdouts; new ship decisions need freshly authored holdouts.
- Never trust a zero-tool-call result: force one call through the exact production path and verify in the memento event log, not the transcript. Headless `codex exec` needs `--dangerously-bypass-approvals-and-sandbox` or every MCP call silently cancels.
- Anti-regexes in scenario checks match usage patterns (`@sendgrid/mail`), never bare words.
