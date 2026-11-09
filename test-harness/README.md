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

## Paid execution is disabled

`bun run harness -- <manifest.yaml>` exits nonzero before any server build,
authentication copying, corpus seeding, agent execution, or results append. This
also applies to no-Memento baselines. Production bundling/preflight fail closed.
There is no production stdio server or local-memory fallback.

Re-enabling execution requires isolated authenticated HTTP fixture accounts,
remote corpus lifecycle and variant control, and authoritative per-rep event and
capture evidence. It must not use a live user's cloud account. Current local
sandbox/scoring helpers remain for offline fixture tests and interpreting saved
results, not as an alternate production workflow. See
[§1](../docs/harness-spec.md#1-purpose-and-scope) for the remote integration gap.
Never launch paid agent evaluations without explicit cost approval.

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
