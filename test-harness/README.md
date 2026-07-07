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

The runner shares the repo's toolchain (no separate package). Typecheck it with:

```sh
bun run typecheck:harness
```

## Status

Build order (§11): variant switch (done) → fixtures/corpus/scenarios (in
progress) → runner (done) → scorers → report → stub server. The runner executes
the hermetic per-rep lifecycle (§7.2) under the spend cap and flake policy
(§7.4) and appends a record per rep to `results/results.jsonl`. Scoring is next
(§11.4): reps currently log session diagnostics with placeholder scores, and
the crowded env is deferred with the stub server (§11 step 6).

Scenarios so far: `read/email-provider` (should-retrieve); three `no-read/*`
should-not-retrieve probes (rename, guard, typo); and three `no-write/*`
should-not-capture probes (lowercase, add-test, extract-helper). The should-not-*
scenarios stage a green saas-app via the `saas-app-mailer` overlay so routine
work keeps the oracle passing — any memento retrieval (no-read) or create/update
(no-write) there is a false positive. Still to author: more `read/*`, and
`write/*` capture scenarios (the last need discovery overlays and the capture
rubric, so they land alongside the scorer).
