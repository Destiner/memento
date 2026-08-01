# Memento

Local, file-owned memory layer for coding agents, exposed as an MCP server.

## Commands

- `bun install` - Install dependencies
- `bun run build` - Compile TypeScript to `dist/`
- `bun run typecheck` - Type-check without emitting
- `bun run lint` - ESLint
- `bun run format` - Prettier (writes; skips `*.md` per `.prettierignore`)
- `bun run test` - Run the Vitest suite
- `bunx vitest run test/foo.test.ts` - Run a single test file
- `bun run typecheck:harness` / `bun run test:harness` - Same for the test harness
- `bun run harness -- test-harness/manifests/<name>.yaml` - Execute a harness run (spawns real agent sessions; costs money/quota)
- `bun run harness:report` - Score and render all results
- `bun run retrospective -- help` - Discover, evaluate, review, promote, report, and export retrospective memory opportunities
- `bun run typecheck:retrospective` / `bun run test:retrospective` - Check the isolated retrospective package

## Stack

- Language: TypeScript (ESM, `NodeNext`), runtime Node >=22.5, managed with Bun
- Protocol: MCP via `@modelcontextprotocol/sdk`
- Store: markdown files (YAML front matter) + SQLite FTS5 search index via `node:sqlite`, which is what pins the Node floor to 22.5
- Test runner: Vitest

## Structure

- `/src` - Server, tools, and store implementation
- `/src/policy` - The instruction surfaces, assembled from `docs/memory-policy.md` as data (`blocks.ts`): server instructions, the AGENTS.md fragment, and both tool-description sets. Print either prose surface with `memento instructions [--server]`
- `/src/variants` - `MEMENTO_VARIANT` registry: context-engineering knob bundles (descriptions/instructions/nudges); `shipped-v2` is the production default, `plain` is the experimental floor
- `/test` - Vitest specs and fixtures
- `/test-harness` - Usage-propensity experiment harness (see `docs/harness-spec.md`): runner, scenarios, fixtures, manifests, results
- `/retrospective` - Offline Claude Code/Codex history evaluation, review, promotion, and regression export (see `docs/retrospection.md`)
- `docs/memory-policy.md` - Canonical memory policy and vocabulary (types, scopes, provenance). Every instruction surface derives from it; edit it before `/src/policy`, and bump `policy_version` for any change to §2-§10

## Patterns

- Markdown files are the authoritative store; the SQLite index is derived and must be rebuildable from `memories/*.md`.
- The store is human-editable: nothing may assume filenames follow the `<id>-slug.md` convention (`get_memory` falls back to front-matter ids — a renamed file must keep working).
- The server CANNOT run under `bun run` (`node:sqlite` is not implemented in Bun); it runs under Node (`node dist/main.js`). Tests pass under `bun run test` only because vitest itself runs on Node.
- Retrospective measurement changes must bump `RETROSPECTIVE_PIPELINE_VERSION`; prompt-only changes also bump the affected prompt version, and output-shape changes bump `EVALUATOR_SCHEMA_VERSION`.

## Harness rules (read `docs/harness-spec.md` before touching experiments)

- Results are append-only in `test-harness/results/results.jsonl`; invalidated runs move to `quarantine-*.jsonl`, never deleted. Scores are always recomputed from the log.
- Comparisons are only valid within one (harness, model, cc_version, memento_version, env) tuple. Bump the package version for any measurement-relevant server change.
- Any new or edited scenario bumps its `version` and MUST pass a baseline-no-memento calibration (utility ≈ 0) before use.
- The `holdout-*` scenario groups were spent 2026-07-31; new ship decisions need freshly authored holdouts.
- Never trust a zero-tool-call result: force one call through the exact production path and verify in the memento event log, not the transcript. Headless `codex exec` needs `--dangerously-bypass-approvals-and-sandbox` or every MCP call silently cancels.
- Anti-regexes in scenario checks match usage patterns (`@sendgrid/mail`), never bare words.
