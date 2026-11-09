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

The first candidate was frozen at `007930f` (0.5.0), with 26 focused evidence tests,
before either new holdout executed. The first synthetic holdout invocation stopped
at schema validation: its project IDs lacked the required `prj_` prefix. Version 2
of that fixture mechanically prefixes those four IDs and their references; no
memory/query text or relevance judgments changed, and no rankings had executed.
The chained private holdout command also had not run.

Pre-holdout scale validation then exposed a blocker in exact rescue: repeated
pagination over prefix decoys took 138–142 seconds at 5,000 records. The 0.5.1
candidate replaces that with a connection-local deterministic SQLite function
applying the **same** Unicode boundary predicate before LIMIT, in one SQL pass.
The same crowded cases now take roughly 40–54 ms, retaining their expected exact
hit/abstention results. Thresholds and labels were not changed. This is a measured
performance correction, not tuning against the holdouts.

Final review also corrected pre-trim raw-query length validation and actual-token
budget validation for empty scopes. Runtime checks found the old advertised Node
22.5 floor could not even create the existing FTS5 index; the documented/runtime
engine floor is now the tested Node 22.16 release. The production index schema is
unchanged. The corrected candidate is committed before evaluating either holdout.

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
shipping evaluations are recorded below, with source/seed hashes and only
aggregate metrics from private data.

## Frozen 0.5.1 evaluation

Production candidate: **`ef5458109221fb7a781f2d5622323e302aba9d8e`**, evaluated only
once on each fresh holdout before inspecting its results. No threshold or label
changes followed. Both holdouts are now spent; the public one is retained as a
regression fixture, not evidence of untouched generalization for future changes.

| Dataset | Useful returns, old → new | Unrelated returns, old → new | Returned precision | No-answer queries returning hits |
| --- | ---: | ---: | ---: | ---: |
| Original synthetic development (40 queries) | 32 → 33 | 137 → 9 | 18.9% → 78.6% | 13/13 → 3/13 |
| Fresh synthetic holdout (30 queries) | 26 → 26 | 69 → 2 | 27.4% → 92.9% | 6/9 → 2/9 |
| Private development (24 queries) | 14 → 15 | 14 → 6 | 50.0% → 71.4% | 3/16 → 2/16 |
| Private heldout (12 queries) | 9 → 8 | 11 → 8 | 45.0% → 50.0% | 0/8 → 0/8 |

**The private heldout is a modest precision/recall tradeoff, not a clean win.**
One useful pair was lost; no answerable query became a complete miss. Its nDCG@5
rose from 0.477 to 0.500, but full recall fell from 9/23 to 8/23 and capped
attainable recall fell from 9/20 to 8/20. All eight no-answer heldout queries have
empty eligible pools, so their zero false-positive rate provides no evidence
about abstention in populated scopes. There are only four answerable queries.
This meets the prespecified one-pair guardrail, but does not warrant claiming
production-wide recall improvement.

Across the private development and heldout samples together, useful returns stayed
**23**, unrelated returns fell **25 → 14**, returned precision rose **47.9% → 62.2%**,
and nDCG rose **0.740 → 0.773**. Combined full recall is 23/64 (35.9%), while capped
recall is 23/40 (57.5%), unchanged. These combined numbers include development data
and must not be presented as heldout performance. The fresh synthetic holdout
retained all 26 labeled relevant pairs and all 21 answerable queries.

Decision: retain the simpler FTS5/evidence ranker, with the documented semantic
limits and real-replay tradeoff. Do not add fuzzy rewriting or a model based on
these data. No scope widening, registry remapping, live-memory mutation, or corpus
cleanup was performed to improve the numbers.

Evidence:

- [`validation/development-0.5.1.json`](validation/development-0.5.1.json)
- [`validation/synthetic-heldout-0.5.1.json`](validation/synthetic-heldout-0.5.1.json)
- [`validation/private-aggregates-0.5.1.json`](validation/private-aggregates-0.5.1.json) — aggregates only; deliberately no private IDs or text.

## Scale, production-path verification, and checks

[`scale.ts`](scale.ts) compares synchronous ranking on deterministic 1,000/5,000
record corpora, including repeated stronger-BM25 identifier-prefix decoys and a
missing-exact-target case. One warmup and three measured samples per query/ranker;
“p95” is the maximum of three samples, not a defensible production tail estimate.
The original slow run is retained, not discarded.

| Case | 0.5.0 current p50 | 0.5.1 observed range / maximum |
| --- | ---: | ---: |
| 1,000 crowded exact / no-target | ~2.4 seconds | maximum ~13 ms |
| 5,000 crowded exact / no-target | ~138–140 seconds | maximum ~54 ms |
| 5,000 mixed queries | — | medians below 1 ms; one sample ~17 ms |

Legacy takes roughly 3–4 ms in the 5,000 crowded cases but misses the exact target
or returns five prefix decoys. The new worst-case overhead buys correct rescue and
abstention. This is a small-memory-store diagnostic, not proof of large-scale
latency. Setup/indexing costs and query samples are separate in
[`validation/scale-0.5.0.json`](validation/scale-0.5.0.json) and
[`validation/scale-0.5.1.json`](validation/scale-0.5.1.json).

[`smoke.ts`](smoke.ts) starts the actual **`node dist/main.js`** executable via MCP
stdio with a new disposable `MEMENTO_HOME`. It creates two synthetic memories,
executes positive and unrelated searches, and checks **four successful events in
the isolated Memento event log**, including server/ranker versions, ordered scores,
limits/filters and absence of content. The home is removed afterward. This passed
on **Node 24.22.1 and Node 22.16.0**, including actual search execution, not merely
SQLite construction. See [`validation/mcp-node24-0.5.1.json`](validation/mcp-node24-0.5.1.json)
and [`validation/mcp-node22-0.5.1.json`](validation/mcp-node22-0.5.1.json).

```sh
bun run build
node --import tsx experiments/search-relevance/smoke.ts /tmp/memento-smoke-new.json
node --import tsx experiments/search-relevance/scale.ts /tmp/memento-scale-new.json
```

All repository static checks/build, experiment checks, core tests, harness tests
(no paid agent runs), and retrospective tests passed. The public seeds now also
have explicit precision/recall/no-answer regression budgets in
`test/integration/search-quality.test.ts`. Existing 0.4.0 baseline outputs remain
reproducible via the frozen ranker; old log schema-2 events remain readable.

Deployment: the checkout's `dist/` is built. Existing long-lived MCP processes need
a restart/reconnection to load 0.5.1. There is no persistent index migration or
model download. The user's running MCP connection was not forcibly terminated.
