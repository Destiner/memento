# Memento Usage-Propensity Test Harness — Specification

Status: V2 harness implemented. Fresh Claude Code and Codex calibration and
activation runs are pending.
Owner: Timur

This document specifies a test harness that measures how context-engineering
interventions ("knobs") change a coding agent's propensity to use the Memento
MCP server — and whether that use is *appropriate*, not merely frequent.

It builds on `docs/memory-policy.md` for the behavior boundary and `v2.md` for the
V2 schemas, instruction surfaces, telemetry, and rollout plan.

Those documents are not duplicated here; this spec covers only the experiment
design and the harness needed to build and run it.

---

## 1. Purpose and scope

**Question under test:** which interventions raise the chance that a coding
agent uses Memento when it should, and leaves it alone when it shouldn't —
measured separately for retrieval (read) and capture (write)?

**Phase 1 scope (this spec):**

- Harness: Claude Code (`claude -p`) or Codex (`codex exec`), single-shot
  headless sessions, selected per manifest (`harness:` key; adapter seam in
  `runner/harness.ts`). Codex added 2026-07 — see §7.2 note. Cross-harness
  numbers compare *ecosystems* (harness+model change together), never
  harnesses in isolation (§12).
- Model: per manifest (`claude-opus-4-8` default; codex manifests set their
  own, e.g. `gpt-5.6-sol`).
- Harness version: detected at run time, recorded per rep (as `cc_version`,
  name kept for log compatibility); baselines rerun on version change (§10).

**Deferred:**

- Multi-turn session scripting (§12).
- Pollution experiment to empirically calibrate λ_write (§5.4).

---

## 2. Terminology

- **Knob** — one intervention with 2–3 variants (off / weak / strong).
- **Config** — a concrete, installable combination of knob variants. Phase 1
  uses one-knob-at-a-time configs plus baselines.
- **Scenario** — fixture repo + task prompt + seeded memory corpus +
  ground-truth label + checks.
- **Rep** — one headless coding-agent session for a (config, scenario) cell.
- **Run** — one manifest execution: a named batch of (config × scenario × rep)
  with a spend cap.

---

## 3. Knob catalog

### 3.1 Product-shipped knobs (zero user setup; portable across harnesses)

These ship inside the Memento server and are the preferred winners: per the
decision rule (§6), they need only a marginal real improvement to ship.

| Knob | Variants | Side |
| --- | --- | --- |
| Tool descriptions | plain (neutral/terse, to be written) / trigger-list (today's shipped text — `8db547f` embedded §11 guidance) | read+write |
| Tool surface shape | the frozen V2 eight-tool surface; future alternatives require a new server version | read |
| MCP server `instructions` field | empty / usage-protocol text (hoisted into system prompt by the client) | read+write |
| Tool-result nudges | plain results / appended prompts (empty search → "consider `create_memory` after the task"; create success → reinforce search habit) | read+write |

**Prerequisite product change — status: complete.** The `MEMENTO_VARIANT`
switch lives in `src/variants/` (registry + env var). Variants: `plain`
(baseline-0 floor), `shipped` (pre-experiment descriptions, kept verbatim),
`server-instructions`, `result-nudges`, and `shipped-v2` — the current
real-world DEFAULT_VARIANT combining all screening-cleared auto knobs
(descriptions + instructions + nudges).

Note the descriptions knob is an **ablation**: the shipped text already
embeds the trigger-list guidance (commit `8db547f`), so measured from the
`plain` floor, today's wording is the knob's strong variant. The code's
`baseline` variant name means "shipped behavior verbatim" — it is *not* the
harness's baseline-0.

### 3.2 User-installed knobs (Claude Code-specific unless noted)

| Knob | Variants | Side | Portable? |
| --- | --- | --- | --- |
| CLAUDE.md addition | none / vague ("use memento") / conditional trigger list; global vs project placement | read+write | partly (AGENTS.md) |
| Skill (memento usage) | absent / present | read+write | no |
| User-prompt nag | none / "use memory" appended to task | read | yes (trivially) |
| SessionStart hook | nothing / memory index (titles) / compact digest | read | no |
| UserPromptSubmit hook | nothing / reminder text / auto-run `search_memories` + inject results | read | no |
| Stop / PostToolUse hook | nothing / capture reminder / hard gate ("did a durable insight emerge?") | write | no |

Notes:

- The user-prompt nag is a **ceiling baseline** (max compliance when told
  explicitly), not a candidate product mechanism.
- The UserPromptSubmit auto-search variant is the determinism end of the
  persuasion↔determinism axis: the model never decides. Its FP and token
  guardrail numbers are the interesting part.
- **Permission friction** (memento tools pre-allowed vs prompted) is a real
  knob but not honestly testable headless (non-interactive mode auto-denies
  rather than prompting). Deferred; all Phase 1 configs pre-allow memento
  tools.

### 3.3 Controlled dimensions (not knobs; fixed or explicitly varied)

- **Environment:** `clean` (memento is the only MCP server) vs `crowded`
  (memento + a fixed, version-controlled set of dummy MCP servers — see
  §7.3 — to reproduce deferred-tool/discoverability pressure).
- **Corpus state:** fully specified per scenario (§4.2).
- **Model / CC version:** pinned per run, recorded in every record.

---

## 4. Scenarios

### 4.1 Classes

Each scenario is labeled with exactly one class. Target: 3–4 scenarios per
class, plus holdouts (§4.4).

1. **should-retrieve** — the corpus contains one memory holding an
   *unguessable, material* fact; the task cannot be done correctly without
   it. Examples:
   - "Add email sending for password resets" + memory "We use Postmark, not
     SendGrid — SendGrid deprecated after deliverability issues."
     Check: output/diff uses Postmark.
   - "Add caching to the API" + memory "Decided against Redis; single-node
     deploy, use in-process LRU." Check: no Redis in diff.
   - "Fix this flaky test" + memory documenting the known root cause.
2. **should-not-retrieve** — trivial, self-contained edits (fix a typo,
   rename a variable, add a null check). Any memento call is a false
   positive.
3. **should-capture** — the task forces the agent to *discover* a durable,
   cross-project insight planted in the fixture (e.g. a sandbox API errors
   with "rate limit: 10 req/min" and finishing requires working around it).
   Pass = a created/updated memory that records the insight (§5.2 rubric).
4. **should-not-capture** — routine tasks that complete cleanly with no
   insight worth keeping. Any create/update is a false positive.

Seeded facts must be: arbitrary (unguessable from training or the repo),
checkable by string/regex in the output or diff, and material to the task.
Calibration (§9 Phase 0) verifies unguessability empirically.

### 4.2 Corpus

Every scenario runs against a seeded corpus of ~10–15 memories: the relevant
one (should-retrieve only) plus plausible **distractors** — retrieval has to
find the right memory among noise, or we're testing propensity but not the
product. Corpus files follow the V2 record format in `v2.md` §3
and are seeded into a temp `MEMENTO_HOME` per rep.

### 4.3 Fixture repos

Small repos under `fixtures/`; the runner copies and git-inits per rep. Each
fixture ships its own **oracle** for task success: a test suite or checklist
command that the scorer runs after the session. A scenario may additionally
specify an **overlay** — a small dir copied on top of the base fixture after
the per-rep copy — used to plant discovery artifacts (e.g. a rate-limited
stub API for should-capture) without forking the whole fixture.

Inventory:

| Fixture | Purpose | Needed by |
| --- | --- | --- |
| `saas-app` (built) | small web app; hosts should-retrieve, should-not-retrieve, and should-not-capture scenarios | Phase 0 |
| `saas-app` overlays | per-scenario planted discoveries for should-capture (stubbed third-party API with rate limit, etc.) | Phase 0 |
| `bigger-app` | larger, realistic repo — the toy-repo-bias reality check (§12); also hosts the holdout scenarios (§4.4) so holdouts run on code the knob wording has never seen | Phase 2 |

### 4.4 Holdout set (Goodhart guard)

~20% of scenarios are held out: never used while iterating knob wording,
run exactly once against the final candidate configs before shipping
recommendations. If a knob's win doesn't survive the holdout, it doesn't
ship.

**STATUS: the `holdout-*` groups are no longer held out.** They are ordinary
scenarios; any future ship decision needs freshly authored holdouts that no knob
iteration has touched.

### 4.5 Scenario definition format

One directory per scenario:

```yaml
# scenarios/read/email-provider/scenario.yaml
id: read/email-provider
version: 1                 # bump on any change; comparisons only within a version
class: should-retrieve
fixture: fixtures/saas-app
task: "Add email sending for password resets."
corpus: corpus/standard-15   # distractor set
seeded_memory: corpus/facts/email-provider.md   # omitted for non-retrieve classes
checks:
  utility_regex: "(?i)postmark"
  utility_anti_regex: "(?i)sendgrid"   # optional: fact violated
  task_success: "bun test"             # run inside the post-session fixture
capture_rubric: null                   # should-capture scenarios define one (§5.2)
```

An optional `overlay:` field (a path under `overlays/`, §4.3) names a directory
copied over the fixture after checkout to stage this scenario's baseline —
completing an app so a should-not-\* edit stays green, or planting a discovery
artifact for should-capture. It is omitted above because `read/email-provider`
needs the fixture exactly as shipped (email deliberately unimplemented).

Changing a scenario in any way bumps `version`; scores are never compared
across scenario versions.

---

## 5. Metrics and scoring

All metrics are computed per (config, scenario class) over N reps, from three
sources: Memento's own V2 event log (`src/logging/events.ts`), the coding-agent
transcript, and the fixture diff/output.

### 5.1 Primary scores

```
read_score  = utility_rate        − 0.33 × read_fp_rate
write_score = good_capture_rate   − 1.00 × capture_fp_rate
```

- **utility_rate** — fraction of should-retrieve reps where the seeded-fact
  check passes in the final output/diff. This subsumes retrieval recall and
  read-through: the fact can't appear unless the model searched, read, and
  applied it.
- **read_fp_rate** — fraction of should-not-retrieve reps with ≥1 memento
  tool call.
- **good_capture_rate** — fraction of should-capture reps where a memory was
  created/updated *and* passes the binary quality rubric (§5.2). A
  created-but-junk memory counts as a miss.
- **capture_fp_rate** — fraction of should-not-capture reps with any
  create/update call.

λ constants: **λ_read = 0.33** (a spurious search is transient token flow),
**λ_write = 1.0** (a junk memory is persistent stock that taxes future
retrievals — a cost invisible to single-session reps, which the weight
imports). λ_write is provisional: the V2 pollution experiment (seed junk
memories, measure read-score degradation vs a clean corpus) converts the
intuition into a number. Escalate λ_write above 1.0 only if results show
configs winning via prolific writing.

Properties worth preserving: a config that never touches memory scores
exactly 0 on both; positive = beats ignoring memory; nag-into-spam can go
negative. Read and write scores are **never merged** into one number.

### 5.2 Capture quality rubric (binary; all must pass)

1. Stored via `create_memory`/`update_memory`, with the event's `memory_id`
   matching the captured file. A `duplicate_candidates` outcome wrote nothing.
2. Records the planted insight (string check against the scenario's fact).
3. Durable phrasing, not a task log (per `docs/memory-policy.md` §3).
4. Correct V2 scope per the repo-vs-memory boundary (`docs/memory-policy.md` §8).
5. Body usable: non-empty. V2 deliberately imposes no heading template.

Judge: checklist script first (string checks + front-matter validation);
LLM judge only if checklists prove too brittle, and then with the judge
prompt version-controlled.

### 5.3 Guardrails (disqualify, don't weight)

A config violating either is out regardless of scores:

- **Task success:** `task_success_rate(config) ≥ task_success_rate(config-0) − 5pp`
  (the 5-point allowance absorbs sampling noise at small N).
- **Token overhead:** total input+output tokens ≤ **+15%** vs config-0,
  measured **only on the true-negative classes** (should-not-retrieve /
  should-not-capture), where any extra spend is pure waste. (Revised
  2026-07-31: the original all-class form counted memory work — searching,
  reading, writing bodies — as overhead and disqualified every effective
  knob on short sessions.)

### 5.4 Diagnostics (logged, never used for decisions)

Retrieval recall (search before first substantive action — first mutating
tool call or final answer), search-to-`get_memory` rate joined by result ids,
memento calls per session, empty-search rate, capture attempts, latency, turn
count, invalid-rep rate.
These explain *why* a score moved; they are all recomputed from the results
log (§8), so adding one later back-fills history.

---

## 6. Decision rules

- **Effect is real** when, in paired per-scenario comparison against
  config-0 (same scenarios, same scenario versions), the delta is positive
  in **≥75% of scenarios** and the mean delta is positive. No eyeballing.
- **Ship threshold is asymmetric:**
  - *Auto knobs* (product-shipped, §3.1 — no user action beyond installing
    the MCP): ship on any real positive delta, however marginal.
  - *User-action knobs* (§3.2): require a substantially larger delta —
    exact number deliberately deferred until preliminary results exist.
- **Ties** between close configs are broken Pareto-style on the raw
  (utility, FP) pair; prefer the dominating config, and among ties prefer
  portable knobs (V2 Codex).
- **Experiment endpoint:** a "recommended install" — best server defaults
  baked into Memento, plus at most 2–3 user-installed knobs documented in
  the README.

---

## 7. Harness architecture

### 7.1 Layout

```
test-harness/
  manifests/          # run manifests (yaml), one per run — version-controlled
  configs/            # one dir per config: installable artifacts + meta.yaml
  scenarios/          # scenario dirs per §4.5, grouped read|no-read|write|no-write
  fixtures/           # fixture repos (as plain dirs; runner git-inits copies)
  overlays/           # optional dirs copied over a fixture to stage a rep (§4.3)
  corpus/             # seeded V2 memory .md files (distractor sets + facts)
  stubs/              # dummy MCP server for the crowded env (§7.3)
  runner/             # runner + scorers (bun scripts)
  results/            # results.jsonl + transcripts/ (gitignored except .gitkeep)
```

Config `meta.yaml` declares: knob id, variant, side (read/write/both),
portability tag, required `MEMENTO_VARIANT` value, and which artifact files
to install (CLAUDE.md fragment, settings.json fragment, hook scripts, skill
dir).

### 7.2 Per-rep lifecycle (hermetic — this is load-bearing)

Harness-specific mechanics live behind a `HarnessAdapter` (`runner/harness.ts`):
invocation shape, result parsing, config-home layout, MCP registration, and
the instructions filename. claude-code: `CLAUDE_CONFIG_DIR`, `--mcp-config`
JSON, CLAUDE.md, hooks+settings. codex: `CODEX_HOME` (auth.json copied in —
file-based, unlike Claude Code's Keychain), `[mcp_servers]` in config.toml,
AGENTS.md, no hooks/settings (plan-time gate). Codex reports token usage but
no dollar cost, so each rep charges the §7.4 fallback — a codex spend cap is
effectively a rep-count cap. Scoring, scenarios, corpus, and the scheduler
are adapter-agnostic.

Every rep runs in a fully isolated environment. The operator's own
`~/.claude/CLAUDE.md`, plugins, skills, and MCP servers must not leak in;
getting this wrong invalidates results silently.

1. Create three unrelated temp roots: `MEMENTO_HOME` (seed a V2 project registry
   plus corpus), fixture copy (git init + commit), and a fresh client config home.
2. Install the config's artifacts into the temp config home / fixture
   (CLAUDE.md, settings with hooks, skill files). Write the MCP server list
   explicitly: memento (with the config's `MEMENTO_VARIANT`) plus, in the
   crowded arm, the stub servers. Pre-allow memento tools in settings.
3. Run the selected adapter's headless command (model pinned) in the fixture
   copy, with a per-rep timeout. Capture the transcript stream.
4. Score: parse Memento's event log + transcript + diff; run the fixture
   oracle; evaluate checks/rubric.
5. Append one JSONL record (§8); save the transcript; delete temp dirs.

Reps are independent; the manifest sets `concurrency` (default 2) —
mind API rate limits and that spend-cap accounting (§9) stays accurate
under parallelism.

### 7.3 Crowded environment

A single stub MCP server in `stubs/` exposing N no-op tools with plausible
names/descriptions, instantiated 3–5 times under different server names via
config. Fixed and version-controlled — never "whatever is on the machine."
This reproduces the deferred-tool discoverability pressure of real setups.

### 7.4 Operational policy

- Per-rep timeout: **10 minutes**. Timed-out or crashed reps are marked
  `invalid`, excluded from scoring (not counted as task failure), retried
  **once** automatically.
- A (config, scenario) cell with >30% invalid reps is flagged for manual
  inspection instead of being scored.
- The runner reads per-session cost from Claude Code's JSON output,
  accumulates it, and **halts the run at `max_spend_usd`**, finishing the
  in-flight reps only.

---

## 8. Run manifest and persistence

### 8.1 Manifest

```yaml
# manifests/screening-1.yaml
name: screening-1
model: claude-opus-4-8        # hardcoded default; matrix dimension in V2
env: clean                    # clean | crowded
reps: 3
concurrency: 2
max_spend_usd: 60
configs: [baseline-0, baseline-no-memento, tool-desc-trigger, server-instructions, sessionstart-index]
scenarios: [read/*, no-read/*]   # globs over scenario ids
```

Invocation: `bun run harness -- manifests/screening-1.yaml`. Manifests are
committed; a run is reproducible from its manifest + repo state.

### 8.2 Results log

Every rep appends one record to `results/results.jsonl`:

```json
{
  "run": "screening-1",
  "timestamp": "...",
  "config": "tool-desc-trigger",
  "config_hash": "sha256:...",
  "scenario": "read/email-provider",
  "scenario_version": 1,
  "rep": 2,
  "model": "claude-opus-4-8",
  "cc_version": "1.6.9",
  "memento_version": "...",
  "policy_version": "2.1.0",
  "env": "clean",
  "status": "ok",              
  "raw": {
    "memento_calls": [...],     
    "utility_pass": true,
    "task_success": true,
    "capture": null,
    "tokens_in": 0, "tokens_out": 0,
    "cost_usd": 0.42, "duration_s": 141, "turns": 9
  },
  "transcript_path": "results/transcripts/screening-1/..."
}
```

`status` ∈ ok | invalid | halted. `config_hash` is a hash of the config
dir's artifacts, so silent config drift is detectable.

**Scores are always recomputed from this log, never stored as the only
copy** — when λ changes or a diagnostic is added, all history re-scores for
free. A small report script renders the config × (read_score, write_score)
table with guardrail violations greyed out, plus diagnostics per config.

---

## 9. Execution plan

Historical initial budget: **~$100**; assume ~$0.30–1.00 per short-fixture session
(~100–300 sessions total). More credits later for Phase 2.

### Phase 0 — Calibration (~$15–25)

`baseline-no-memento` (Memento not registered at all) × **all** scenarios ×
N=2. Validates the instruments before spending on knobs:

- Seeded facts must be unguessable: utility ≈ 0 without memory. Any
  scenario where the model guesses the fact cold gets rewritten and
  re-calibrated.
- Tasks must be completable: high task-success rate; this doubles as the
  guardrail baseline.

### Phase 1 — Screening (~$50–60, `max_spend_usd: 60`)

`baseline-0` (Memento installed, `plain` variant) + 4–6 single-knob configs, clean
env only, N=3, scenario subset matched to knob side (read knobs → read +
no-read scenarios; write knobs → write + no-write). Goal: kill obvious
losers, produce preliminary deltas, and let Timur set the user-action ship
threshold (§6) from real numbers.

### Phase 2 — Focused (next credit batch)

Top 3–4 knobs from screening: both envs, all non-holdout scenarios, N=10.
This produces the numbers the decision rules run on. Only after Phase 2:
small factorials over the 2–3 most promising combinations (knobs interact;
one-at-a-time first, combos second).

### Phase 3 — Holdout + recommendation

Final candidate configs × holdout scenarios × once. Survivors ship per §6.

### Rerun / tweaking workflow (ongoing)

- **New knob:** add a config dir + meta.yaml; run it against `baseline-0`
  in a new manifest. Baselines already logged for the same (model,
  cc_version, memento_version, policy_version, env, scenario_version) are
  reusable — the log is the cache.
- **Changed scenario:** bump `version`; it needs Phase-0 calibration before
  use; no cross-version comparisons.
- **Changed λ / new metric:** recompute from `results.jsonl`; nothing reruns.
- **Model or CC version changed:** new run name; rerun `baseline-0` (and
  `baseline-no-memento` if scenarios changed) under the new version before
  comparing anything. Comparisons are only valid within one (harness, model,
  cc_version, memento_version, policy_version, env, scenario_version) tuple.
- **Iterating knob wording:** freely, against non-holdout scenarios only.

---

## 10. Baselines

- `baseline-no-memento` — Memento not registered. Anchors task-success and
  token guardrails; calibrates unguessability.
- `baseline-0` — Memento installed with the neutral variant
  (`MEMENTO_VARIANT=plain`: terse descriptions, no `instructions` field, no
  nudges), zero user-installed knobs. The 0-line every knob is paired
  against. **This is deliberately not today's shipped default:** `8db547f`
  already embedded trigger-list guidance in the descriptions, so shipped
  behavior is itself a knob variant under test, not the baseline. If
  baseline-0 carried an undeclared intervention, every knob's delta —
  not just the descriptions knob's — would be measured on top of it.

Both rerun whenever model or CC version changes (§9).

---

## 11. Prerequisites checklist (build order)

1. `MEMENTO_VARIANT` switch — done (`src/variants/`). Remaining product
   change: the `plain` neutral variant baseline-0 pins (§3.1, §10).
2. Fixtures + corpus + scenario definitions (calibration-ready), per the §4.3
   inventory (`saas-app` done; `bigger-app` deferred to Phase 2). Overlay
   staging (§4.3) is in place. Splits by scoring dependency:
   - **2a (now):** the retrieve, no-retrieve, and no-capture classes —
     scored by the regex/oracle checks the runner already runs.
   - **2b (with step 4):** should-capture scenarios + their discovery
     overlays. A capture scenario can't be calibrated without the capture
     rubric that scores it, so it is authored alongside the scorer, not
     here. Still lands before Phase 0 — all of §11 precedes the execution
     plan (§9).
3. Runner: hermetic per-rep lifecycle (§7.2), manifest execution, spend cap,
   flake policy.
4. Scorers: event-log/transcript parsers, checks, capture rubric, oracle
   runner — plus the should-capture scenarios + discovery overlays deferred
   from 2b, built and calibrated against the rubric here.
5. Report script over `results.jsonl`.
6. Stub MCP server (needed for Phase 2, not Phase 0/1).

---

## 12. Known blind spots

Stated so results are not mistaken for more than they are:

- **Single-shot sessions underestimate capture** — real capture often
  follows a "works, thanks" turn. Multi-turn scripting is V2.
- **Fresh-session propensity only** — no longitudinal dynamics (staleness,
  reuse over weeks, corpus growth; cf. `product.md` §14 "shape of
  behavior").
- **Permission friction untestable headless** — deferred knob.
- **Toy-repo and single-fixture bias** — Phase 0/1 run almost entirely on
  `saas-app`, and retrieval propensity likely differs on long tasks;
  `bigger-app` in Phase 2 (§4.3) is the partial control for both.
- **Harness and model are confounded** — a Codex arm changes both at once, so
  cross-harness tables answer "does memento work in that ecosystem," never
  "which harness uses memory better." Knob rankings must be established
  within one (harness, model) pair.
