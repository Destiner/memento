# Precision-first implementation evaluation

## Design and data separation

The original 40-query seed is now **development/regression data**, including its
old diagnostic “heldout” half. It was visible during research and implementation;
we do not claim it as an untouched test set.

A different author created `holdout.json` (28 synthetic memories, 30 queries)
without viewing ranker implementation or earlier outputs. Another author recovered
36 real queries from 27 local conversations, joined all of them to historical
telemetry by exact query ID, and labeled them against a read-only snapshot of
82 current memory documents. The real queries are split by task/conversation into
24 development and 12 heldout cases, with no task or conversation overlap.

Private queries, memory text, project IDs, provenance and per-query outputs remain
outside the repository in a mode-0700 directory under `/tmp`; files are mode 0600.
They were not submitted to external services. Labels were assigned and reviewed
by an agent, not a human, without ranking output. Useful partial answers and
material premise correction count as relevant. These are current-corpus replays,
not historical result reconstructions. Shared bodies and duplicate display names
are preserved under their exact original IDs, without silently aliasing scopes.

**Empty pools are reported separately.** Thirteen private development queries and
eight private heldout queries have no currently eligible documents, often because
historical IDs differ from same-named current projects. Those cases cannot validate
ranking discrimination. Several broad private queries have more than five useful
memories; both micro recall and recall relative to the maximum attainable at five
are reported. Do not mistake capped recall for corpus-wide recall.

## Development and freeze

The chosen model-free approach retains FTS5, removes function words, measures
scope-local stemmed evidence, accepts useful explicit clauses, and protects exact
references. No fuzzy expansion or embedding model is shipped. The coverage
threshold is **0.30**, combined with a two-term minimum (one for single-term
queries); this is not the original research's destructive 0.60 cutoff. See
[`docs/search.md`](../../docs/search.md) for the complete algorithm.

Development iteration:

1. Initial candidate: original seed 33 useful / 9 irrelevant returns, versus
   legacy 32 / 137. Private development: 15 useful / 6 irrelevant, versus 14 / 14.
2. Independent code review found literal-fragment, punctuation-boundary,
   crowded-pool, Unicode rescue and query-budget bugs. These were corrected and
   tested with separate synthetic regressions, without viewing either new holdout.
3. Strict path suffix checks initially also rejected plain identifiers followed
   by executable extensions. Private development caught the lost useful answer.
   Kind-aware boundaries and a synthetic executable/member-access regression
   restored 15 useful / 6 irrelevant returns without lowering the acceptance gate.

The final development candidate has 26 focused evidence tests in addition to the
existing search/filter/integration suite. Query-size validation is explicit;
actual SQLite token expansion is bounded; dedupe remains broad; exact rescue
paginates past rejected prefix matches instead of imposing a pre-validation limit.
The feature is frozen in its implementation commit **before executing either new
holdout**. Later corrections, if needed, must be described rather than silently
retuning and reusing a spent holdout.

Pre-evaluation decision checks:

- All static checks/build/tests and exact scope/status/type/dedupe contracts pass.
- Each new evaluation set must reduce irrelevant returned slots, without increasing
  no-answer false-positive queries.
- Retained useful pairs should not fall by more than one pair (small-sample recall
  guardrail); missed-positive queries must not increase.
- Report nDCG, returned precision, full and capped recall, and absolute counts;
  don't hide empty-pool cases or treat tiny sets as a production accuracy estimate.
- Benchmark a larger synthetic corpus and force one actual MCP search through the
  compiled server, verifying its isolated event log. No paid propensity-harness
  runs are necessary to test deterministic retrieval itself.

## Reproduction

The frozen 0.4.0 implementation is in `legacy-index.ts`; all 40 retained baseline
rankings and scores are regression-tested against the original output. The current
arm goes through the production `searchMemories` operation and is cross-checked
against the raw index output.

```sh
bunx tsc -p experiments/search-relevance/tsconfig.json
bunx vitest run --config experiments/search-relevance/vitest.config.ts
node --import tsx experiments/search-relevance/compare.ts \
  experiments/search-relevance/seed.json /tmp/memento-development-new.json
# Execute only after freezing a candidate; this spends the holdout:
node --import tsx experiments/search-relevance/compare.ts \
  experiments/search-relevance/holdout.json /tmp/memento-holdout-new.json
```

Output paths must be new and outside the repository. The runner creates temporary
canonical markdown/project fixtures and in-memory indexes, cleans them up, and
writes mode-0600 results. Project display names in the disposable registry use
opaque IDs, so historical duplicate names cannot trigger accidental deduplication;
retrieval eligibility uses the original IDs unchanged.

The initial experiment files and outputs remain as historical evidence. New
shipping evaluations will be recorded below, with source/seed hashes and only
aggregate metrics from private data.
