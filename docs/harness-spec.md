# Memento usage-propensity harness: maintainer reference

The harness measures whether a coding agent retrieves and captures memory when
appropriate, rather than maximizing tool calls. [Memory policy](memory-policy.md)
defines the behavior boundary; this document defines measurement and maintenance.
For commands and directory navigation, see [the harness README](../test-harness/README.md).

## 1. Purpose and scope

Each rep is a paid, single-shot headless Claude Code or Codex session in an
isolated fixture. A manifest selects the client, model, environment, configs,
scenarios, repetition count, and spend cap. Do not launch sessions without
explicit approval for the cost. Local harness tests do not require paid runs.

The implementation lives in `test-harness/runner/`. Schemas in `manifest.ts`,
`config.ts`, and `scenario.ts` are authoritative for accepted configuration.

## 2. Terminology

- **Knob:** an intervention being evaluated (server guidance, instructions, hooks).
- **Config:** an installable combination of interventions, including baselines.
- **Scenario:** fixture, task, corpus, class, and scoring checks.
- **Rep:** one session for a config/scenario cell.
- **Run:** one manifest's config × scenario × rep batch.

## 3. Configs and controlled dimensions

### 3.1 Server variants

`configs/<name>/meta.yaml` declares `name`, `knob`, `variant`, `side`
(`read|write|both`), `portability` (`portable|partial|non-portable`), and
`memento_variant`. A null Memento variant means no server is registered.
Server variants are defined in `src/variants/`; do not duplicate that registry
in experiment documentation.

### 3.2 Installed artifacts

Optional `install` fields select an instruction fragment (`claude_md`) or the
canonical generated instructions (`agent_instructions: memento`), plus settings,
hooks, or a skill directory. Fragment and generated instructions are mutually
exclusive. Artifact paths are relative to the config directory.

Codex plans reject hooks, skills, and settings fragments before any paid session.
Instruction fragments are installed using the adapter's instructions filename
(AGENTS.md for Codex).

### 3.3 Controlled dimensions

Keep client/model, client version, environment (`clean|crowded`, §7.3), and corpus
controlled rather than treating them as undeclared interventions.

## 4. Scenarios

### 4.1 Classes

- **should-retrieve:** an arbitrary, material seeded fact is needed for the task.
- **should-not-retrieve:** a self-contained task; any Memento call is a false positive.
- **should-capture:** completing the task exposes a durable planted insight.
- **should-not-capture:** routine work; any create/update attempt is a false positive.

Facts must be unguessable from the repository or training, material, and
checkable. Every new or edited scenario must bump its `version` and pass a
`baseline-no-memento` calibration with utility approximately zero before use.
This is an operator requirement, not an automatic calibration gate.

### 4.2 Corpus

`corpus` names a directory of memory Markdown files; `seeded_memory` adds the
relevant fact for retrieval scenarios. Use plausible distractors so retrieval
must find the right fact, not merely notice that a server exists. The runner
seeds a fresh Memento home and project registry for every rep. Each home's
`config.json` sets `memory_archive_after_days` and `memory_delete_after_days` to
`MAX_MEMORY_RETENTION_DAYS` from `src/config.ts` (365000 days), identically for
all configs including baselines. This controlled retention setting keeps
historical seeds available at real server startup without rewriting corpus
timestamps or ranking data, or simulating reads. Logging retains its defaults.
The harness measures retrieval of the authored corpus, not wall-clock decay.

### 4.3 Fixture repos

Fixtures are plain directories under `test-harness/fixtures/`. The runner copies
the fixture, applies an optional `overlay`, then git-initializes and commits the
baseline. Overlays replace files or add discovery artifacts without duplicating
a whole fixture; they must not contain a repository's `.git` state.

`checks.task_success` is an optional shell command run in the post-session
fixture. Supply an oracle that tests the requested behavior without prescribing
the seeded answer. Utility is scored before the oracle can modify files.

### 4.4 Holdouts

Fresh shipping decisions require freshly authored holdouts untouched by config
iteration. Existing `holdout-*` groups are spent and may be used only as ordinary
scenarios, not as independent evidence for a new shipping decision.

### 4.5 Scenario format

One `scenario.yaml` per `scenarios/<group>/<name>/`; its `id` must match the path.
Paths below are relative to `test-harness/`. This example illustrates the format;
use the checked-in scenario's current version when running it.

```yaml
id: read/email-provider
version: 1
class: should-retrieve
fixture: fixtures/saas-app
task: Add email sending for password resets.
corpus: corpus/standard-15
seeded_memory: corpus/facts/email-provider.md
checks:
  utility_regex: '(?i)postmark'
  utility_anti_regex: '(?i)@sendgrid/mail|api\.sendgrid\.com'
  task_success: bun run check
capture_rubric: null
```

Optional `overlay: overlays/<name>` stages the baseline (§4.3). Retrieval
scenarios require `seeded_memory` and `utility_regex`; capture scenarios require
a `capture_rubric` (§5.2). Anti-regexes must match actual usage patterns, not bare
provider names that might appear in explanatory comments.

## 5. Metrics and scoring

`score.ts` records facts while the sandbox exists; `report.ts` recomputes rates
from the JSONL log. Server event logs, not transcript claims, are authoritative
for Memento calls. Utility checks match **added diff lines**, not the final
answer; a passing regex alone does not prove retrieval occurred.

### 5.1 Primary scores

```text
read_score  = utility_rate      − 0.33 × read_fp_rate
write_score = good_capture_rate − 1.00 × capture_fp_rate
```

- `utility_rate`: should-retrieve reps passing the positive regex and not
  matching the optional anti-regex.
- `read_fp_rate`: should-not-retrieve reps with any logged Memento call.
- `good_capture_rate`: should-capture reps passing all capture criteria.
- `capture_fp_rate`: should-not-capture reps with any create/update attempt.

Read and write scores remain separate. Report flags can change the weights
without rerunning sessions; the write penalty is a policy weight, not an
empirically calibrated cost of corpus pollution. Missing classes yield missing
rates; do not interpret a partial-class report as a complete evaluation.

### 5.2 Capture quality rubric

A rep passes only when one new or changed memory satisfies all five criteria:

1. A successful create/update event identifies that memory's front-matter id.
   A duplicate-candidate response alone is not a stored memory.
2. Title, description, or body matches `insight_regex`, without matching the
   optional `insight_anti_regex`.
3. Title and description avoid the scorer's task-log markers and optional
   `task_log_anti_regex`.
4. Scope kind matches `expected_scope` if supplied; otherwise it is present.
5. The body is non-empty; no heading template is required.

Example rubric for a planted reusable operational constraint:

```yaml
capture_rubric:
  insight_regex: '(?i)single.transaction|--single-tx'
  expected_scope: [projects]
```

These are deterministic heuristics in `capture.ts`, not a semantic quality judge.
Review borderline cases against the memory policy; do not claim the rubric
fully validates durability or the repository-versus-memory boundary.

### 5.3 Guardrails

The report compares shared scenarios against the selected baseline (default
`baseline-0`):

- Task success must be at least baseline minus 5 percentage points.
- Mean input+output tokens must be no more than 15% above baseline, checked
  separately on each true-negative class. Positive classes are excluded because
  useful memory work itself costs tokens.

Missing baseline or usable data produces `n/a`, not evidence of passing.
Guardrail failures disqualify a config rather than adjusting its score.

### 5.4 Diagnostics

The report includes invalid rate, calls and searches per session, empty-search
rate, search-to-get rate, capture attempts, duration, turns, and cost. These help
explain scores but are not substitutes for task utility and capture quality.

## 6. Interpreting comparisons

Compare configs on the same scenarios and scenario versions, within the boundaries
in §9. The decision rule requires a positive paired delta against `baseline-0`
in at least 75% of scenarios and a positive mean delta. Inspect false positives
and guardrails as well as aggregate scores. The report does not automate this
rule or establish statistical significance.

Product-shipped interventions need a real positive delta; user-installed
interventions must justify their additional setup cost. Prefer the dominating
utility/false-positive pair and portable, low-friction interventions when benefits
are otherwise comparable. Reserve fresh holdouts for confirmation.

## 7. Runner architecture and safety

### 7.1 Source map

- `manifest.ts`, `config.ts`, `scenario.ts`, `plan.ts`: validation and cell planning.
- `harness.ts`: client invocation, authentication setup, and transcript parsing.
- `sandbox.ts`, `mcp.ts`, `settings.ts`: isolated installation and MCP wiring.
- `preflight.ts`: bundle and verify the server before paid reps.
- `session.ts`, `run.ts`: process supervision, scheduling, retries, spend accounting.
- `score.ts`, `utility.ts`, `capture.ts`, `event-log.ts`: per-rep facts.
- `record.ts`, `report.ts`, `report-cli.ts`: persistence and reporting.

### 7.2 Hermetic lifecycle and event verification

Each rep gets three unrelated temporary roots: memory storage, fixture worktree,
and client configuration. Keep them unrelated: an agent must not discover hidden
seed files through a sibling directory of an environment-exposed config home.
The operator's instructions, plugins, skills, MCP registrations, and git settings
must not contaminate the fixture.

The runner installs the config artifacts, seeds the corpus and registry, writes
an explicit MCP configuration, and invokes the selected client with a pinned
model. Claude Code uses `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME` with copied
file-based authentication. Codex requires an existing `codex login`.
After the session, the runner collects events, diff, capture results, oracle
results, and transcript usage; it saves artifacts, appends a record, and cleans
up temporary directories.

Preflight bundles the current server, checks initialization for each requested
variant, forces `resolve_project` through the same bundled stdio server, and
requires its event-log entry before paid reps start. This does **not** prove a
client permits MCP calls. Before trusting a zero-call result, force a call through
the exact client/model/config production path and verify the server event log.
Headless Codex needs `--dangerously-bypass-approvals-and-sandbox` (included by the
adapter); without it MCP calls can silently cancel. Run only trusted fixtures
and artifacts: client execution deliberately bypasses permission protections.

### 7.3 Environments

`clean` registers only Memento when enabled by the config. `crowded` additionally
registers the fixed dummy-server profiles in `stubs/profiles.ts`, served by
`stubs/server.ts`. These no-op tools provide controlled discoverability pressure;
do not replace them with the operator's live integrations.

### 7.4 Timeouts, retries, and spend

Defaults are concurrency 2, timeout 600 seconds, and one retry for invalid reps;
the manifest can override them. Timed-out, failed, or unparseable sessions are
invalid, not task failures. Every attempt is logged and charged. Cells with more
than 30% invalid attempts are flagged and excluded from report scoring.

`max_spend_usd` is required. The scheduler stops launching work or retries once
accounted spend reaches the cap; in-flight work finishes, so this is not a hard
billing ceiling. Sessions without reported cost charge a $2 fallback estimate.
Codex reports tokens but no dollar cost, so its cap is effectively an estimated
rep budget. Leave headroom for concurrency, retries, and estimation error.

## 8. Manifests and persistence

### 8.1 Manifest format

```yaml
# test-harness/manifests/example.yaml
name: example
harness: claude-code            # claude-code | codex
model: claude-opus-4-8
env: clean                     # clean | crowded
reps: 3
concurrency: 2
max_spend_usd: 30
timeout_s: 600
retries: 1
configs: [baseline-no-memento, baseline-0, shipped-v2]
scenarios: [read/*, no-read/*, write/*, no-write/*]
```

`name` must match the manifest filename. Scenario selectors are exact ids or
whole-segment wildcards (`read/*`, not `read/em*`). Unknown configs and unmatched
selectors fail planning. Commit manifests so runs can be interpreted with their
repository state; do not assume an old manifest is appropriate for a new ship
comparison.

### 8.2 Results and artifacts

Every attempt appends to `test-harness/results/results.jsonl`. Records include
run/config identity and config hash, scenario id/version/class, client/model/
server/policy versions, environment, status (`ok|invalid|halted`), raw scoring
facts and usage, and transcript/diff paths. See `record.ts` for the exact schema.

Results are append-only. Move invalidated runs to `quarantine-*.jsonl`, never
delete them. Keep transcripts and diffs for audit. Recompute aggregate scores
from the log rather than maintaining a separate authoritative score table.
New diagnostics can only be backfilled if their required raw facts were saved.

## 9. Versioning and comparison boundaries

Compare only within one `(harness, model, cc_version, memento_version,
policy_version, env)` tuple and matching scenario versions. `cc_version` is the
client version for either adapter; the field name is retained for compatibility.
Bump the package version for measurement-relevant server changes and the scenario
version for every scenario change. Inspect config hashes for artifact drift.

The report groups by the environment/version tuple but only **warns** about
mixed scenario versions; that warning is not permission to compare them. Different
client/model pairs measure different ecosystems, not an isolated client effect.

## 10. Baselines

- `baseline-no-memento`: no server registered; calibrates seeded-fact
  unguessability and measures task/token behavior without memory.
- `baseline-0`: server installed with `MEMENTO_VARIANT=plain`, without user-side
  artifacts; neutral reference for interventions, not the shipped default.

The report's guardrail baseline defaults to `baseline-0`; select another with
`--baseline` explicitly. Baselines from another comparison tuple are not valid
substitutes.

## 11. Limitations

- Single-shot sessions miss capture that follows a later confirmation turn.
- Fresh sessions do not measure staleness, corpus growth, or long-term reuse.
- Small fixtures and regex/rubric heuristics limit generalization and semantic
  quality claims; successful utility checks can be guessed or gamed.
- Non-interactive permission bypass cannot measure real approval friction.
- Cross-client/model comparisons are confounded; establish config rankings
  within each client/model pair.
