# Retrospective memory evaluation

Memento's retrospective pipeline finds moments in completed coding-agent sessions
where memory should have been searched or preserved, compares those opportunities
with what the agent actually did, and turns human-reviewed judgements into an
evaluation dataset.

It exists to measure the part ordinary tool telemetry cannot see: work where a
memory operation was useful but never happened. Tool-call volume can show what an
agent did; it cannot supply the missing denominator of eligible searches and
eligible learnings.

The pipeline is an offline evaluation system. It is not a public MCP feature, an
automatic transcript importer, or an autonomous memory writer.

## Design boundaries

- The code and data live separately from the MCP server and durable memory store.
- Raw Claude Code and Codex histories remain where their clients created them.
  Memento stores an internal path and content fingerprint, not a second raw copy.
- Only redacted, bounded context is persisted in the evaluation database or sent
  to an evaluator.
- Search opportunities are evaluated using only information available at the
  checkpoint. Events after the checkpoint are excluded.
- Actual Memento calls and results are hidden from proposal generation. They are
  introduced only during comparison, so the evaluator cannot endorse an action
  merely because it saw the agent take it.
- Text emitted in the same source message as a Memento call is hidden as well.
  Later assistant text with a distinctive verbatim overlap from a retrieved
  memory is replaced by a contamination marker. Paraphrased or short downstream
  influence cannot be detected reliably, so this is a shadow evaluation rather
  than a perfect counterfactual replay.
- Search evaluation never queries the memory store. It judges whether searching
  was warranted, not whether a matching memory happened to exist.
- Write evaluation may use the completed task, because a learning can only be
  judged after it has been established.
- A proposal cannot change durable memory until a person reviews it and runs a
  separate promotion command.

## Data flow

```text
Claude Code / Codex JSONL histories
                |
                v
      parse + normalize in memory
                |
                v
      redact and bound all content
                |
                v
        tasks and checkpoints
          |                |
          | prefix only    | completed task
          v                v
    search proposals   capture proposals
          \                /
           v              v
       compare with actual Memento operations
                        |
                        v
              human review queue
                  |             |
                  v             v
          evaluation data   explicit promotion
```

## Supported clients and evaluators

The history adapters understand both Claude Code and Codex persistent JSONL,
including unwrapped Codex rollout records. They normalize the clients into a
shared chronological representation while retaining client, model, client
version, timestamps, and parent-agent relationships. If one source session
switches models, its model is recorded honestly as `mixed` instead of attributing
the whole session to the first model observed.

Both clients can also be used as the evaluator:

- `claude-code` runs a non-persistent, tool-disabled Claude Code process with a
  strict JSON schema.
- `codex` runs an ephemeral Codex process in an empty, read-only working directory,
  ignores user config and repository rules, disables shell, web, app,
  plugin, browser, computer, stateful-goal, dependency-install, and subagent
  capabilities, and uses a strict output schema.

Prompts state the trusted policy and evaluator objective before placing transcript
content inside explicit untrusted-evidence delimiters. Session text cannot change
the instruction hierarchy. Both adapters receive prompts on standard input rather
than command-line arguments, and every response is parsed against the same strict
schema before persistence.

Codex 0.145 does not expose a strict-config switch for its read-only `view_image`
capability. The evaluator supplies no images, redacts local absolute paths, starts
in an empty directory, and explicitly forbids all tool calls, but this remains a
residual isolation limitation for operators assessing highly sensitive histories.
The Codex adapter also converts the canonical Zod schema to the provider's strict
subset (`anyOf`, every property required, optional values nullable), then removes
only those synthetic nulls before validating the canonical output.

The evaluator is selected per run. Its provider, actual local CLI version,
requested model string, prompt-suite version, output-schema version, and policy
version are included in the deterministic run identity. The providers do not
reliably expose a resolved model ID for every invocation, so run metadata keeps
the requested model separately and records the provider-resolved value as
unavailable rather than pretending an alias is a pinned ID. Evaluation invokes a
remote model; ingestion, review, reporting, and export do not.

## Operator workflow

Install dependencies with `bun install`. The evaluator CLI selected for a run
must also be installed and authenticated (`claude` for `claude-code`, `codex` for
`codex`). The pipeline never supplies credentials or performs an interactive
login.

The default Memento home is `~/.memento`; `MEMENTO_HOME` or `--home` can select a
different one. Use the same home for the complete workflow. It contains both the
retrospective database and the project/memory store into which an approved write
is eventually promoted.

Start by listing the histories the installed clients have retained:

```sh
bun run retrospective -- discover --client both
```

Runs accept only explicit, client-qualified paths. They never sweep every
discovered session implicitly. Remote evaluation is also a separate opt-in and
defaults to one task, which puts a hard initial bound on cost and disclosure:

```sh
bun run retrospective -- run \
  --source claude-code:/path/to/claude-session.jsonl \
  --source codex:/path/to/codex-session.jsonl \
  --evaluator claude-code \
  --model <model> \
  --max-tasks 2 \
  --allow-remote
```

Use `--evaluator codex` with a Codex model to run the same schemas and passes
through the other adapter. A run can ingest histories from either or both source
clients regardless of which evaluator judges them. `--source-policy-version`
may annotate otherwise-unknown historical sessions only when the deployment
window is trustworthy; leaving it unset preserves `unknown`.

`--max-tasks` is one global cap over the earliest tasks across all selected
sources, not a per-source limit. Each selected task makes one checkpoint-selection
request, one capture request, and one to six search-checkpoint requests, so a task
costs 3–8 remote evaluator calls. The default remains one task.

Prefer an immutable provider model ID for `--model` when one is available.
Moving aliases cannot be resolved reliably by either CLI, so an alias can change
remote behaviour without changing the locally derived run identity; use a pinned
ID or an explicit `--run-salt` for a deliberately independent repeat.

The command prints a deterministic run id. Repeating the same inputs with the
same evaluator CLI reuses an evaluated run, while an interrupted run resumes
after each atomically stored task outcome. A task whose context or evaluator
response cannot be processed is recorded as a redacted task failure; evaluation
continues with later tasks instead of stalling the run. Use `--run-salt <label>`
when an intentional independent retry or repeat is needed with otherwise
identical inputs. An evaluator CLI upgrade automatically produces a different
run id.

Inspect and decide the queue with:

```sh
bun run retrospective -- runs
bun run retrospective -- queue <run-id>
bun run retrospective -- review <comparison-id> approve --actor <name>
bun run retrospective -- review <comparison-id> reject \
  --actor <name> --reason "Not durable"
bun run retrospective -- review <comparison-id> edit \
  --actor <name> --reason "Corrected scope and match" \
  --revision proposal.json --label missed --actual-operation none
bun run retrospective -- review <comparison-id> duplicate \
  --actor <name> --reason "Already captured" --target-memory <mem_id>
```

An edit file is a complete replacement proposal in the same strict schema as the
original. An edit also requires the reviewed label and an explicit match to an
actual operation ID, or `none` to detach the evaluator's match. The operation must
belong to the same task, have the right kind, and remain one-to-one across the run.
This makes the revised proposal, label, metrics, and export agree.

Decisions are append-only and normally final. An approved write returns to the
default queue when promotion reports `duplicate_candidates`, `ambiguous`, or
`failed`. Duplicate/ambiguous outcomes permit an edit or duplicate link; a failed
promotion can also be rejected, edited, or retried. Once a write proposal is
approved, promotion remains an explicit second command:

```sh
bun run retrospective -- promote <comparison-id>
bun run retrospective -- report <run-id>
bun run retrospective -- export <run-id> --output ./reviewed-regressions.jsonl
```

`runs`, `queue`, and `report` accept `--json`. Mutation commands and `export`
already print JSON. `queue` normally shows undecided items and repairable
promotion outcomes; use `queue <run-id> --all` to recover the ID and audit trail
of any decided item, or of a proposal collapsed as a repeat of another (see
"Repeated opportunities").

## Normalization

The adapters retain genuine user and assistant messages, relevant ordinary tool
calls and results, timestamps, model identifiers, bounded project context, and
Memento operations. They discard hidden thinking/reasoning, encrypted content,
system and developer prompt bodies, Claude meta/system user records, world-state
records, attachments, binary payloads, and unrelated client bookkeeping.

Subagents are not treated as unrelated sessions. Claude Code sidechains and Codex
child-agent histories are attached to their parent task and merged chronologically.
Client bookkeeping and Claude meta/system records do not become task boundaries,
and Codex fork replays are removed conservatively. A single operation represented
in multiple client events is deduplicated by its call id. When Codex supplies
provisional and later authoritative MCP records for one call, the authoritative
server identity and richer result win.

The adapters recognize the eight Memento tool names and retain the original name
alongside the canonical operation.

Malformed or unknown JSONL records are counted as warnings. A non-empty file from
which no recognizable conversation can be recovered fails as an unsupported
format; it is never treated as a valid session with zero opportunities.

## Redaction and privacy

Redaction happens immediately after raw parsing and before content is bounded,
persisted, or sent to an evaluator. Evaluator outputs and human edit revisions
pass through the same safety gate before persistence. Redaction covers, among
other patterns:

- credentials embedded in URLs;
- authorization and cookie headers;
- secret-like environment keys and assignments;
- private keys and PEM blocks;
- common provider-token formats;
- emails and home-directory paths.

Redacted values become typed placeholders that name the category without
preserving the value. Binary attachments and unsupported client records are
dropped by the adapters; recursively oversized text and JSON are bounded with
typed truncation markers.

Failure handling depends on the stage. A source that cannot be safely redacted is
quarantined and produces no session. A redaction or validation failure in an
evaluator response records a task failure after the session itself has been
ingested, then continues with later tasks. An unsafe review reason or edit is
rejected without appending a review event.

Pattern-based redaction reduces risk but cannot prove that arbitrary source code
or customer context is non-sensitive. Review the explicit source paths before
enabling remote evaluation and keep each run narrow. A future local evaluator can
implement the same evaluator interface without changing the pipeline.

## Tasks and checkpoints

A genuine top-level user message starts a task. Tool results, injected environment
messages, and inter-agent traffic do not. The pipeline always creates a task-start
checkpoint and may select a small number of later meaningful checkpoints, such as
after a new failure signal or a material discovery.

Checkpoint selection may use the completed task, but each search evaluator request
is reconstructed independently from the prefix ending at that checkpoint. Tests
assert that two sessions with identical prefixes produce identical search requests
even when their suffixes differ.

Long tasks are compacted deterministically: the first and last events are kept,
semantically useful and evenly distributed events are sampled, and text/tool JSON
is recursively bounded until the request fits both event and character limits.
Only real source event IDs are retained, so checkpoint validation still applies.
Compaction is visible through typed truncation markers and trades detail for the
ability to evaluate the rest of a large corpus.

Search proposals contain a query, optional intent/type filters, rationale, and an
explicit scope. Capture proposals contain a complete create/update candidate in
the canonical Memento taxonomy plus a rationale. Before evaluation, every
distinct checkout hint retained across a merged parent/child session is resolved;
all exact canonical IDs become task context. If any hint is ambiguous or missing,
the context is marked `projectResolutionIncomplete`; the evaluator must not treat
the known IDs as the whole scope. Otherwise, evaluator-proposed project IDs must
be a subset of those IDs. When the evaluator knows an opportunity is
project-specific but canonical IDs are missing, it must use the
evaluation-only `unresolved_projects` scope—never invent an ID or silently widen
to global. The evaluator may return zero proposals; zero is a normal and
important result.

A session started in a directory that *contains* registered checkouts rather than
in one of them gets a further resolution pass. `resolve_project` reports the
containing project when a caller stands inside a checkout, but has no tier for a
caller standing above several, so such a session would otherwise fall through to
the fuzzy-name tier and resolve as ambiguous—leaving every project-specific
proposal in `unresolved_projects`, which cannot be approved without a review
edit. The projects registered beneath the directory become the candidate set
instead: real IDs the evaluator must narrow to a justified subset, with
`projectResolutionIncomplete` still set, because an unregistered checkout may
also live there. Ancestor evidence is weaker than a checkout match, so it is
consulted only when the standard tiers name no single project, and one hint
contributes at most `MAX_DESCENDANT_PROJECTS` candidates; truncation is reported
as a session warning rather than applied silently.

## Actual operations and comparison

Native histories provide the semantic arguments of attempted Memento calls. The
Memento event log can independently verify that a call reached the server and add
the log schema, server, policy, variant, client version, result outcome, and opaque
result identifiers. Reconciliation requires a unique compatible candidate under
tool, client, time, and outcome constraints plus independent identity evidence:
overlapping memory IDs or the same complete project-ID set. Telemetry
`session_id` names a server process, not a source conversation, and is never used
as identity evidence. Multiple strong candidates remain ambiguous; a lone
time/tool/client-only candidate stays unmatched. A transcript call with neither a
tool result nor matched telemetry is classified `transcript_only` during
comparison.

The normalizer understands scopes in `update_memory`'s nested `changes` and treats
the returned memory scope as authoritative when present.

Comparison is one-to-one, so one actual call cannot satisfy several proposals. It
evaluates semantic similarity, timing, and scope separately, then persists a queue
label and explanation:

- `timely`
- `late`
- `missed`
- `unnecessary_candidate`
- `incorrect_scope`
- `ambiguous`
- `transcript_only`
- `attempted_not_stored`

These labels are provisional until reviewed.

## Repeated opportunities

Each search checkpoint is evaluated independently from the prefix ending at it, so
an opportunity present for a whole task is proposed again at every checkpoint that
follows it. Because comparison is one-to-one, at most one member of such a set can
be matched to an actual call and the rest are labelled `missed` however well the
agent behaved—which would make the missed count scale with checkpoint count
instead of with behaviour, and make tasks of different lengths incomparable.

Within a task, proposals describing one opportunity are therefore grouped after
matching, and every member except the representative records
`duplicate_of_comparison_id`. Grouping is deterministic and local—normalized
token similarity over query and intent, at or above
`DUPLICATE_SIMILARITY_THRESHOLD`, within one scope kind—because run identity and
resumption require the same inputs to produce the same result. The threshold is
deliberately high: a false merge hides a finding, while a false split only costs
one review decision.

Matching runs first so it stays free to pick the best proposal for each actual
call, and a group containing a match is represented by that member, so the group
reads `timely` or `late` rather than collapsing to `missed`. A matched proposal is
never recorded as a duplicate: two matches in one group mean the agent really did
search twice, and collapsing them would erase an operation that happened.

Nothing is discarded. Duplicates stay in the database and remain visible through
`queue <run-id> --all`; they are excluded from the default queue, from reviewed
ground truth, and from every rate derived from it, so one opportunity contributes
once.

## Review

The review queue supports four append-only actions:

- `approve` — the opportunity or actual operation is correctly classified;
- `edit` — approve a corrected proposal while preserving the original revision;
- `reject` — the proposed opportunity is not valid, with a reason;
- `duplicate` — the proposed write is already represented by a named memory.

Only reviewed items contribute to activation and capture metrics. Review events are
never overwritten; current state is derived from their ordered revisions. An
edit records a complete proposal, corrected label, and an explicit actual-operation
match or detachment. The store validates task membership, operation kind, and
one-to-one use before accepting a match. An approved write may receive a follow-up
edit or duplicate decision after promotion reports `duplicate_candidates` or
`ambiguous`; a failed promotion also permits repair or rejection.

Home-aware approval and edit commands snapshot the complete durable state of an
update target as a SHA-256 digest. The snapshot is append-only review evidence,
not evaluator output. Promotion refuses a legacy approval without a snapshot and
returns a changed target to the queue as `ambiguous`, where a new edit can confirm
the current state.

An `unresolved_projects` write cannot be approved as-is. The reviewer must use an
append-only edit to supply a canonical project or global scope. Search proposals
may retain unresolved scope as evaluation evidence, where comparison treats the
scope relation as ambiguous rather than incorrectly scoped.

## Promotion

Approval makes a genuinely unstored capture proposal eligible for promotion but
does not promote it. A proposal already matched to a successful or uncertain
actual write is never promoted again. Eligibility is derived from the effective
actual-operation evidence—not an editable label. Only a verified
`duplicate_candidates` result proves an attached write stored nothing; a generic
error can occur after Markdown was written and remains indeterminate. An explicit
review edit may detach a match after the operator verifies the durable store.
Promotion is a separate explicit operation that:

1. resolves every project against the current project registry;
2. validates the edited proposal against the current memory schema;
3. calls the normal `createMemory` or `updateMemory` operation;
4. respects the duplicate gate and never sets `force_create` automatically;
5. records the outcome idempotently in the evaluation database.

An append-only review edit is also the authority for a registered multi-project
scope that is broader than ingestion could establish. Updates replace the
reviewed body, project-ID set, and evidence set rather than merge stale arrays
from the existing memory. The normal store serializes creates, updates, archives,
and index rebuilds with one crash-recoverable SQLite write lock. Inside that lock,
an update verifies the reviewed full-record digest against the exact record read
for the write and retains the exact-body `old_text` guard. The promotion claim
checks the current review sequence, state, and proposal in the same evaluation
database transaction, so neither a concurrent store mutation nor a concurrent
review decision can race a stale promotion.

Search proposals have no promotion path. Raw transcript paths are never copied into
durable provenance. A duplicate-candidate result leaves the proposal unpromoted so
the reviewer can link or edit it. A failed promotion is recorded, returns to the
default queue, and the same explicit promotion command starts a new attempt using
the comparison id.

A process crash can leave an attempt in `started` when it is impossible to know
whether the durable write completed. The pipeline deliberately does not retry
that state automatically because doing so could double-write; the operator must
inspect the durable store and the recorded proposal. Reconcile the audit record
explicitly after that check:

The same rule covers create or update cleanup/index failures after Markdown was
written. The normal memory operation first rebuilds the derived index from
authoritative Markdown where possible. If repair fails—or an update cannot remove
its old filename—it reports the durable memory ID and deliberately leaves
promotion `started` rather than presenting the operation as safely retryable.

```sh
bun run retrospective -- reconcile-promotion <comparison-id> succeeded \
  --actor <name> --reason "Verified the created memory" --memory <mem_id>
bun run retrospective -- reconcile-promotion <comparison-id> failed \
  --actor <name> --reason "Verified that no write completed"
```

The successful form first verifies that the named memory exists in the same
`--home`, rebuilds the complete derived index, and refuses reconciliation if any
canonical memory file is skipped. The failed form makes an intentional retry
possible. Neither outcome is inferred automatically.

## Storage and versioning

The authoritative evaluation database is separate from the durable store:

```text
$MEMENTO_HOME/retrospective/evaluation.sqlite
```

It uses explicit migrations and is never dropped or rebuilt automatically because
it contains human judgements. Source fingerprints, stable derived ids, unique
constraints, and transactions make ingestion, evaluation, review, and promotion
safe to retry. On Unix-like systems the retrospective directory is forced to
mode `0700` and the database to `0600`; regression exports are also created as
owner-only files.

Each run records the pipeline and database schema versions, normalized-session
schema, evaluator prompt/output schemas, canonical policy, source
client/model/version data, source fingerprints, project-resolution outcomes, and
evaluator identity. Adapter, redaction, task-planning, and comparison changes are
versioned by the pipeline version. Reconciled actual operations additionally keep
the Memento server and policy versions when telemetry supplies them.

There are two distinct policy axes. A session's source policy version describes
the instructions under which the historical agent acted; it comes from matched
Memento telemetry or an explicit operator override. The evaluator policy version
describes the current canonical policy supplied to the retrospective judge. They
answer different questions and are never substituted for one another.

Memento currently emits `policy_version` only when a tool is called. A session with
zero Memento calls therefore has no authoritative policy version. Such sessions are
stored as `unknown` unless the operator supplies a trustworthy deployment window.
Reports preserve that distinction and never infer a version from calendar time.

## Metrics and regression export

Reviewed data supplies the dimensions needed for metrics that ordinary telemetry
cannot provide:

- eligible-session search activation;
- eligible-learning capture;
- timely, late, missed, and incorrect-scope rates;
- unnecessary-operation rate;
- evaluator proposal acceptance and rejection;
- differences by source client/model, evaluator/model, policy, and pipeline version.

The built-in report currently renders reviewed-only activation and capture rates,
label/decision totals, task-failure count, and promotion outcomes. The SQLite
records and regression export retain the source/evaluator dimensions for deeper
stratification.

Regression export writes sanitized reviewed examples without raw history paths.
Each case includes the bounded prefix or completed-task evaluator context, task
summary, effective reviewed proposal and label, effective actual-operation match,
review decision, and evaluator identity. Capture cases therefore retain their
completed-task input rather than only the model-generated summary. They are
evaluator fixtures first, not automatically test-harness scenarios. Turning one
into a harness scenario remains deliberate work: scenario versioning, a
baseline-no-memento calibration, and fresh holdout discipline still apply.

## Development

The retrospective package is isolated from the production TypeScript build while
reusing canonical policy, schema, project-resolution, and memory-operation modules.

```sh
bun run retrospective -- help
bun run typecheck:retrospective
bun run test:retrospective
```

The test suite uses sanitized fixtures, injected evaluators, and local stub
executables that exercise both Claude Code and Codex CLI lifecycles without a
network. It never starts a paid Claude Code or Codex session. Live end-to-end runs
require an explicit remote evaluation flag and a selected evaluator/model.

Any measurement-relevant change to ingestion, redaction, task selection,
compaction, reconciliation, or comparison must bump
`RETROSPECTIVE_PIPELINE_VERSION`. Prompt-only changes also bump their individual
checkpoint/search/capture prompt version, and output-shape changes bump the
evaluator schema. These identifiers are part of the run identity; forgetting a
bump can make unlike evaluations appear resumable or comparable.
