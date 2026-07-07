# Memento test harness

Measures how context-engineering interventions ("knobs") change a coding
agent's propensity to use Memento — and whether that use is *appropriate*.
See `../harness-spec.md` for the full experiment design; this README is the
operational quick reference.

## Layout (§7.1)

- `manifests/` — run manifests (yaml), one per run; committed.
- `configs/` — one dir per config: installable artifacts + `meta.yaml`.
- `scenarios/` — scenario dirs (§4.5), grouped `read|no-read|write|no-write`.
- `fixtures/` — fixture repos as plain dirs; the runner git-inits copies.
- `overlays/` — optional dirs a scenario copies over its fixture to stage the
  per-rep baseline (green up an app, plant a discovery artifact) without forking it.
- `corpus/` — seeded memory `.md` files (distractor sets + `facts/`).
- `stubs/` — dummy MCP server for the crowded env (§7.3).
- `runner/` — runner + scorers (bun scripts).
- `results/` — `results.jsonl` + `transcripts/` (gitignored except `.gitkeep`).

## Running

```sh
bun run harness -- test-harness/manifests/<name>.yaml
```

Render the results after a run (§8.2) — scores are recomputed from the log every
time, so a different λ re-scores all history without rerunning anything:

```sh
bun run harness:report                         # results/results.jsonl
bun run harness:report -- --lambda-write 1.5   # re-score with a different weight
bun run harness:report -- --results <path> --baseline baseline-0 --no-color
```

It prints, per (model, cc, env) group, the config × (read_score, write_score)
table with guardrail-violating rows dimmed, plus the §5.4 diagnostics; cells with
>30% invalid reps (§7.4) and scenarios spanning versions (§9) are flagged.

The runner shares the repo's toolchain (no separate package). Typecheck it with:

```sh
bun run typecheck:harness
```

## Status

Build order (§11): variant switch (done) → fixtures/corpus/scenarios (done) →
runner (done) → scorers (done) → report (done) → stub server (done). The runner
executes the hermetic per-rep lifecycle (§7.2) under the spend cap and flake policy
(§7.4), scores each rep, and appends a record to `results/results.jsonl`; the report
(`bun run harness:report`) recomputes scores and guardrails from that log.

The crowded env (§7.3) is now available: a single stub MCP server (`stubs/server.ts`)
is instantiated once per profile in `stubs/profiles.ts` (issue tracker, error
monitor, feature flags, product analytics), each under its own server name, adding
~20 no-op tools that reproduce deferred-tool discoverability pressure. The profile
set is fixed and version-controlled (`CROWDED_PROFILES`); a manifest opts in with
`env: crowded`. Stubs are pure distractors — deliberately not source-control or
filesystem tools the agent might legitimately call and then hit a no-op.

Scoring (§5, §11 step 4) reads three sources while the sandbox is still on disk:
Memento's event log (`$MEMENTO_HOME/logs/`) for the authoritative list of tool
calls the report derives FP rates from; the git diff of the session's changes for
the should-retrieve utility check (regex over added lines only); and the fixture
oracle (`task_success`) as the guardrail. should-capture reps are scored against
the five-criterion capture rubric (§5.2) over the memories the session created or
edited. Read and write scores are recomputed from the log, never stored (§8.2).

Scenarios: three `read/*` should-retrieve (email provider, reset-link domain,
security contact — each seeds an unguessable fact into the corpus and checks it
lands in the diff); three `no-read/*` should-not-retrieve probes (rename, guard,
typo); three `no-write/*` should-not-capture probes (lowercase, add-test,
extract-helper); and three `write/*` should-capture (migrate --single-tx, Postmark
sandbox stream, seed idempotency — each plants a discovery artifact whose failure
message states a cross-project constraint the agent must find, then capture). The
no-read/no-write scenarios stage a green saas-app via the `saas-app-mailer`
overlay; the write scenarios use `saas-app-ops`, which greens the app and plants
the discovery scripts. Thematic diversity within saas-app is limited by design —
`bigger-app` in Phase 2 is the fix (§12).
