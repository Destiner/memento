# Memento test harness

Measures appropriate memory retrieval and capture in isolated, single-shot coding
agent sessions. The [maintainer reference](../docs/harness-spec.md) covers scenario
design, scoring, isolation, comparison boundaries, and limitations.

## Layout

- `manifests/`: committed YAML batches of configs × scenarios × repetitions.
- `configs/`: installable interventions and `meta.yaml` declarations.
- `scenarios/`: task definitions, corpus references, and checks.
- `fixtures/`, `overlays/`: base repositories and scenario-specific staging files.
- `corpus/`: distractors and seeded facts in memory Markdown format.
- `stubs/`: fixed no-op MCP profiles for `env: crowded`.
- `runner/`: validation, client adapters, isolation, scheduling, scoring, reporting.
- `results/`: append-only `results.jsonl` and transcript/diff artifacts.

## Local checks (no paid sessions)

From the repository root:

```sh
bun run typecheck:harness
bun run test:harness
```

## Running a batch (paid)

**This launches real agent sessions and consumes money/quota. Obtain explicit
approval before running.** Authenticate the selected client first; Codex requires
file-based authentication from `codex login`.

Review the manifest's model, configs, scenario versions, repetitions, concurrency,
retry count, and required `max_spend_usd`. Spend accounting can overshoot while
in-flight sessions finish; Codex uses an estimated per-session charge rather than
reported dollar cost. See [§7.4](../docs/harness-spec.md#74-timeouts-retries-and-spend).

```sh
bun run harness -- test-harness/manifests/<name>.yaml
```

Preflight verifies a real call against the bundled server before paid reps.
Before interpreting zero-call results, also force a call through the exact
client/model/config path and verify the **server event log**, not the transcript
([§7.2](../docs/harness-spec.md#72-hermetic-lifecycle-and-event-verification)).
Use only trusted fixtures and config artifacts: headless client execution
bypasses permission protections.

## Reporting (no new sessions)

```sh
bun run harness:report
bun run harness:report -- --lambda-write 1.5
bun run harness:report -- --results <path> --baseline baseline-0 --no-color
```

Reports recompute read/write scores, guardrails, and diagnostics from the saved
log. They group by client, model, client/server/policy versions, and environment.
Cells with more than 30% invalid attempts are excluded; mixed scenario versions
are warned about, not made comparable. Missing baseline data is not a guardrail
pass. See [§5](../docs/harness-spec.md#5-metrics-and-scoring) and
[§9](../docs/harness-spec.md#9-versioning-and-comparison-boundaries).

Preserve results: move invalidated runs into `quarantine-*.jsonl`, never delete
them. New or changed scenarios require a version bump and no-Memento calibration;
new shipping decisions require fresh holdouts. Existing `holdout-*` groups are
spent. See [§4](../docs/harness-spec.md#4-scenarios) before authoring experiments.
