# Retrospective memory evaluation

Memento's retrospective pipeline finds moments in completed Claude Code and Codex
sessions where memory should have been searched or preserved, compares proposals
with actual operations, and turns human-reviewed judgements into evaluation data.
It is not an automatic transcript importer or autonomous memory writer.

## Cloud boundary

Production memory is accessible only through authenticated HTTP Memento. The CLI
never starts a stdio server, reads a local live memory registry, or mutates local
memory files. Local evaluation data remains supported, but every database command
requires an explicit `--data-dir <directory>`. There is no default `~/.memento`,
`MEMENTO_HOME`, or `--home` fallback. The evaluation database lives at:

```text
<data-dir>/retrospective/evaluation.sqlite
```

`run` resolves project hints through the SDK Streamable HTTP transport. Set
`MEMENTO_URL` to the HTTPS MCP endpoint and `MEMENTO_ACCESS_TOKEN` in the process
environment. Credentials are never written to configuration or evaluation data.
URLs containing credentials, queries, or fragments are rejected, as are HTTP
URLs; redirects are refused. Connection/tool failures fail closed, without a
local registry fallback. An authenticated resolution request can send checkout
hints to the configured server; review the selected histories and endpoint.

There is currently no remote telemetry export integration. CLI runs use history
operations/results only, not local server logs. Calls without a result remain
`transcript_only`; missing source policy remains `unknown` unless explicitly
annotated. This limitation must not be interpreted as verified remote delivery.

### Disabled durable-memory operations

`promote` and `reconcile-promotion` fail before opening a database or touching any
memory. Remote correctness requires server-side conditional writes against the
reviewed full-record digest, durable idempotency, and authoritative reconciliation
evidence after uncertain writes. A client-side get followed by update cannot
provide those guarantees. Neither a local write nor an unconditional remote
write is a safe substitute.

Update approvals/edits and duplicate links also fail closed because they require
verification of durable target state. Other offline review actions, including
create approvals, remain available as evaluation judgements only. Approval does
not imply a memory was written. Approved, unpromoted writes remain `reviewing`,
not falsely `complete`.

Low-level home-aware promotion/reconciliation/review and file-based project
resolution functions remain for core fixture tests. They are not CLI workflows
or a supported local production alternative. Existing promotion audit records
remain readable in reports and exports. To enable these commands safely, the
server must first expose the consistency and recovery capabilities above.

## Operator workflow

Install dependencies with `bun install`. `discover`, `runs`, `queue`, supported
`review` actions, `report`, and `export` do not contact a remote model or require
Memento credentials. Discover reads the clients' retained history locations:

```sh
bun run retrospective -- discover --client both
```

Evaluation requires an installed, authenticated evaluator CLI (`claude` or
`codex`). The pipeline does not log in or supply evaluator credentials. Supply
Memento credentials through the environment, not command-line arguments or files.
`run` accepts only explicit client-qualified source paths and requires opt-in to
remote model evaluation:

```sh
bun run retrospective -- run --data-dir ./evaluation-data \
  --source claude-code:/path/to/session.jsonl \
  --source codex:/path/to/session.jsonl \
  --evaluator claude-code --model <model> --max-tasks 2 --allow-remote
```

`--max-tasks` is a global cap, default one. Tasks follow source/session order,
not global timestamp order. Each task costs 3–8 evaluator requests: checkpoint
selection, capture, and one to six searches. Never run paid evaluation without
approval for its cost and disclosure.

The evaluator can judge histories from either client. Use immutable model IDs
when available: requested aliases cannot be reliably resolved and may drift.
`--run-salt <label>` deliberately starts an independent run. CLI upgrades,
pipeline, prompt, schema, policy, source fingerprints, and project resolutions
contribute to deterministic run identity. Repeating completed inputs reuses the
run; interrupted runs resume from atomically stored task outcomes. Unsafe or
invalid evaluator output records a redacted task failure and continues.

```sh
bun run retrospective -- runs --data-dir ./evaluation-data
bun run retrospective -- queue <run-id> --data-dir ./evaluation-data
bun run retrospective -- review <comparison-id> approve \
  --data-dir ./evaluation-data --actor <name>
bun run retrospective -- review <comparison-id> reject \
  --data-dir ./evaluation-data --actor <name> --reason "Not durable"
bun run retrospective -- review <comparison-id> edit \
  --data-dir ./evaluation-data --actor <name> --reason "Corrected classification" \
  --revision proposal.json --label missed --actual-operation none
bun run retrospective -- report <run-id> --data-dir ./evaluation-data
bun run retrospective -- export <run-id> --data-dir ./evaluation-data \
  --output ./reviewed-regressions.jsonl
```

`runs`, `queue`, and `report` accept `--json`; mutation commands and export print
JSON. `queue --all` includes decided items and audit trails. Review edits are
complete replacement proposals in the strict schema. Match an operation from the
same task, of the correct kind, one-to-one across the run; use `none` to detach.
An unresolved project-specific write must be edited to canonical scope rather
than approved as-is. Decisions are append-only.

## Evaluation and privacy boundaries

Raw histories remain where clients wrote them. The database retains source paths
and fingerprints, not second raw copies. Parsing and normalization discard hidden
thinking, encrypted content, system/developer prompts, injected metadata,
attachments, binary payloads, and unrelated bookkeeping. Claude sidechains and
Codex child sessions attach to their parent tasks; replayed calls deduplicate.
Malformed records produce warnings; an unrecognizable nonempty source fails.

Redaction happens before bounding, persistence, or remote evaluation. It covers
URL credentials, authorization/cookie headers, secret-like assignments, private
keys, common provider tokens, emails, and home paths. Typed placeholders replace
values. Evaluator outputs and human revisions pass the same safety gate. Failed
source redaction quarantines the source; unsafe reviews are rejected without
appending an event. Pattern-based redaction cannot prove arbitrary code or
customer context is safe. Keep source selection narrow.

A genuine top-level user message starts a task. Tool results and injected traffic
do not. Every task has a start checkpoint and may have later selected checkpoints.
Search proposals see only the prefix ending at the checkpoint and never query
memory. Capture proposals may see the completed task. Actual Memento calls,
results, and text in the same source message are hidden from proposal generation;
later distinctive verbatim retrieved text is masked. Short or paraphrased
contamination cannot reliably be detected: this is shadow evaluation, not a
perfect counterfactual replay. Bounded/compacted contexts mark omitted material.

Every checkout hint is resolved before evaluation. Only exact canonical project
IDs enter scope context. Missing/ambiguous hints mark project resolution incomplete;
project-specific proposals must use evaluation-only `unresolved_projects` rather
than inventing IDs or widening to global. Zero proposals is a valid result.

Evaluators receive trusted instructions followed by explicit untrusted-evidence
delimiters and prompts on stdin. Claude Code uses a nonpersistent tool-disabled
process with a strict JSON schema. Codex uses an ephemeral process in an empty
read-only directory, ignoring user configuration and repository rules, disabling
shell/web/app/plugin/browser/computer/subagent and related capabilities. Codex's
read-only `view_image` capability remains a residual isolation limitation; no
images are supplied, paths are redacted, and prompts forbid tool calls.

## Comparison, reports, and exports

Comparison is one-to-one and evaluates semantics, timing, and scope separately.
Provisional labels are `timely`, `late`, `missed`, `unnecessary_candidate`,
`incorrect_scope`, `ambiguous`, `transcript_only`, and `attempted_not_stored`.
Returned memory scope is authoritative; nested update changes are normalized.
Low-level reconciliation tests retain strict independent identity requirements:
time/tool/client proximity alone never proves a telemetry match.

Only reviewed items contribute to activation/capture metrics. Reports retain
unknown source policy separately from current evaluator policy, task failures,
and promotion audit outcomes. Exports contain sanitized reviewed context,
effective proposals, labels, matches, decisions, and evaluator identity, without
raw source paths. They are evaluator fixtures, not automatically calibrated
harness scenarios. Scenario versioning, no-Memento calibration, and fresh holdout
discipline still apply.

The SQLite database uses migrations and is never automatically rebuilt: it owns
human judgements. Stable IDs, unique constraints, and transactions protect retry
behaviour. Unix directory/database permissions are 0700/0600; exports are
owner-only. Source model switches are recorded as `mixed`; zero-call source
policy remains `unknown` unless a trustworthy deployment window is supplied via
`--source-policy-version`.

## Offline usage dashboard

The separate `memento report --snapshot <export-directory>` command renders an
explicit offline export containing `logs/`, `memories/`, and `projects/`. It is
read-only and loopback-only, never loads a live local home, and does not fetch
cloud telemetry. Missing snapshot directories fail rather than displaying a
misleading empty live dashboard. There is no automatic cloud export command yet.

## Development and versioning

```sh
bun run typecheck:retrospective
bun run test:retrospective
```

Tests use sanitized fixtures, injected evaluators/project lookups, SDK fetch
stubs, and local evaluator executables; they never start paid agent sessions.
Core store fixtures are explicitly test-only. Measurement changes bump
`RETROSPECTIVE_PIPELINE_VERSION` (currently 1.4.0); prompt changes also bump the
affected prompt version, and shape changes bump the evaluator schema. Pipeline
versions prevent cloud/history-only evaluation from resuming older local runs.
