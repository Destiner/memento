# Search relevance study (offline, 2026-11-09)

Read [FINDINGS.md](FINDINGS.md) for the research, historical analytics, measured results, and recommendation.

This is a **research prototype**, not a server change, shipping recommendation benchmark, or usage-propensity harness run. It needs no model, API key, new package, or network. It never opens the live Memento home. Do not use these synthetic scores as production relevance estimates.

## Reproduce

From the repository root, with dependencies installed and Node >=22.16:

```sh
node --import tsx experiments/search-relevance/run.ts /tmp/memento-search-results.json
bunx tsc -p experiments/search-relevance/tsconfig.json
```

`run.ts` replays only the original `seed.json`. Its historical `current` arm now uses the **frozen 0.4.0** implementation in `legacy-index.ts`, `legacy-schema.ts`, and `legacy-types.ts`, copied from `c0cd93a`. It inserts records in the historical markdown rebuild's filename order, preserving ties. The snapshot has no production imports, including no mutable schema, tokenizer, query, or project-ID helpers. Do not sync it with production. Prototypes still use a separate **in-memory** FTS5 table. All indexes close in `finally`. Output must be a new path outside the repository, created exclusively with mode `0600`; no stdout result dump or overwrite is allowed. No MCP server or agent session is launched. The existing propensity harness, result logs, scenarios, and production source remain untouched.

The production `searchMemories` wrapper equivalence assertion was an **initial historical check**, not a guarantee that future production matches the snapshot. It is intentionally removed from this frozen replay rather than casting the snapshot to the production index type. Use `compare.ts` below to evaluate actual current production.

`results.json` is the retained initial run. Reproduce to another path rather than overwriting this evidence. The output records source commit, seed hash, runtime versions, per-query hits, aggregates, and timing. In the initial evidence, source commit identifies the baseline; experiment files were uncommitted at initial execution. New replays also identify the frozen baseline separately with `legacyVersion` and `legacySourceCommit`. SQLite/runtime versions remain recorded: freezing TypeScript and DDL cannot freeze SQLite's native implementation across runtime upgrades. The regression test makes any resulting legacy drift visible.

## Explicit-fixture production comparison

```sh
node --import tsx experiments/search-relevance/compare.ts \
  experiments/search-relevance/seed.json /tmp/memento-search-comparison.json
# Optional cold, single-pass diagnostic timings (NOT production performance):
# append --timing; use a new output filename for every execution.
bunx vitest run --config experiments/search-relevance/vitest.config.ts
bunx tsc -p experiments/search-relevance/tsconfig.json
bunx eslint experiments/search-relevance/*.ts
bunx prettier --check experiments/search-relevance/*.ts experiments/search-relevance/tsconfig.json
```

There is **no default input or live-store path**. `compare.ts` evaluates exactly the explicitly supplied full corpus; it never discovers fixtures or reads adjacent files. **Do not supply `holdout.json` or any future/private fixture until explicitly authorized.** The tests read only the original `seed.json` and `results.json`; the root Vitest config does not discover these experiment tests.

The current arm writes canonical Markdown and a synthetic project registry under a fresh private OS temporary directory, uses production `rebuildIndex` with an in-memory `MemoryIndex`, and calls the actual production `searchMemories` operation for every query. Its returned IDs and rounded scores are asserted equal to a raw production index call; rows preserve raw scores/BM25 plus the operation's `returnedScore`. The legacy arm inserts the same validated documents into its own in-memory frozen index. All databases and temporary directories are cleaned in `finally`, including failures. No production API changes, unsafe index casts, new dependencies, or model calls are needed.

### Input and provenance

Use the original seed shape: `version`, `projects: [{id, name}]`, `memories: [{id, title, description, body, scope, type, status?, verification?}]`, and `queries: [{id, query, scope, relevant, types?, status?, split?, category?, rationale?}]`. Document status and query status default to active; omitted query split becomes `unspecified`; project query match defaults to `any`. A query's `types` and inclusive `status` filters apply to labels and both arms. Unknown document/query fields, duplicate IDs/labels/project references, missing registry references, malformed production records/queries, and ineligible labels/hits fail validation. Queries may have arbitrarily many relevant labels, including more than five. Every query requests **up to five**, with no padding or fallback fill.

Output preserves `seedVersion`, exact input-byte `seedSha256`, and all top-level metadata other than the document/query/project arrays in `seedMetadata` (including any original full-corpus/replay metadata, without recomputing or replacing its hashes/version). Normalized corpus/query hashes are separately named and are not replacements for the original byte hash. Each split retains the same full-corpus identity, input hash/version, and its own normalized query-set hash; splits never rebuild a smaller index. `summary` distinguishes `kind: all` from named splits, even if a split is itself called `all`.

Rows contain query **IDs, not query text or rationale**, binary labels, eligible-pool size, ordered raw hits, and every missed label. Outputs remain sensitive: use a private directory outside the repo. Output creation refuses existing files, symlinks, and repository paths (including symlinked parent directories), and sets `0600`. Do not commit comparison outputs.

### Comparison metrics

Each arm and split reports machine-readable counts and:

- `microRecallAt5`: total relevant returned pairs / all relevant labels.
- `cappedAttainableRecallAt5`: total relevant returned pairs / sum of `min(5, relevant labels per query)`. This measures attainment of the top-five ceiling, **not** full-label recall; nDCG also caps its ideal ranking at five.
- `ndcgAt5`: mean binary nDCG over answerable queries, including zero for misses.
- `returnedPrecision`: relevant returned pairs / actual returned slots, over all queries, without padded slots.
- `noAnswerFalsePositiveRate`: no-answer queries returning anything / all no-answer queries, including empty eligible pools.
- `nonemptyPoolNoAnswerFalsePositiveRate`: the same rate restricted to no-answer queries whose metadata-eligible pool is nonempty. This pool is based on scope/types/status, not lexical matches.
- Missed-positive-query and missed-relevant-pair counts, alongside per-query misses and raw hits.

Undefined ratios are JSON `null`, never NaN or an invented perfect score. Optional timings deliberately warn that legacy is ranking-only while current includes registry validation, with no warmup and one pass. This is a tiny-corpus execution diagnostic, **not a latency comparison, scalability benchmark, or production-performance claim**.

## Fixed experiment design (written before first execution)

An independent author supplied **40 memories and 40 queries** before seeing any ranker outputs. Memories include two projects, global scope, a cross-project record, two archived records, and near-topic distractors. Queries have exhaustive synthetic binary relevance labels and explanations. There are 27 answerable queries (34 relevant query/document pairs) and 13 no-answer queries. Multi-clause questions deliberately allow a useful partial answer. The development/heldout split is diagnostic: both use one corpus and several paired scope/status cases, so it is **not an independent validated holdout**. No tuning or label edits based on heldout scores are allowed.

All methods return **up to five**, with the same scope/status eligibility. All stored records use the same timestamp to avoid recency confounding. Production includes its real metadata adjustments; alternatives intentionally ablate those adjustments rather than claiming a clean one-factor causal comparison. Production BM25 and prototype BM25 see the same whole corpus, with eligibility filters before candidate limiting. Prototypes use a 30-document candidate pool; current uses its actual default pool of 30. This corpus cannot test larger-pool starvation.

### Arms

| Arm | Fixed recipe |
| --- | --- |
| `current` | Historical name: frozen 0.4.0 `MemoryIndex.search`; cross-checked against the production `searchMemories` operation at the initial run only. |
| `weighted` | Deduplicate query terms; remove the fixed English function-word list in `run.ts`; retain Porter/unicode61; FTS5 BM25 weights title 4, description 2, body 1; no metadata additions or relevance gate. |
| `coverage_040/060/080` | `weighted`, then require 40%, 60%, or 80% of weighted query-term evidence before top-five truncation. All three thresholds are a prespecified sensitivity sweep, not tuned winners. |
| `fuzzy_060` | `coverage_060`, with conservative spelling correction: an out-of-vocabulary word of at least five characters may become its unique one-edit neighbour in eligible documents. One edit includes adjacent transposition. Known words and ambiguous corrections are untouched. |
| `rrf_ungated` | Fuse `weighted` and character-trigram Dice rankings over title+description with reciprocal rank fusion (constant 60, equal weights, 30 candidates per channel). No relevance gate. This is lexical+lexical fusion, **not semantic hybrid search**. |
| `rrf_060` | The same fusion, gated by exact stemmed query coverage at 60%. |

Coverage uses unique Porter stems obtained from SQLite itself, including body terms. Each query stem gets weight `log(1 + (N + 0.5)/(df + 0.5))`, where `N` and `df` are computed within the eligible scope/status pool. **Absent terms stay in the denominator** with `df=0`; dropping them would erase the evidence that a requested vendor or subject is missing. This is a heuristic evidence fraction, **not a probability**. Scores are still ordered by weighted BM25 (or RRF), not by coverage. Neither negation nor multi-intent query decomposition is modeled. Function-word removal includes negation words and thus is unsafe to ship as a semantic treatment of negation.

Fuzzy correction is experimental, not a safe identifier policy: an unseen technical name can be mistakenly corrected to another name. Character trigrams are computed explicitly in JS; this is **not** a claim that FTS5's trigram tokenizer natively provides edit-distance search. The vocabulary and statistics are recomputed per query for transparency, not optimized for scale. No synonyms, embeddings, semantic model, or package-specific search engine is tested.

### Metrics

- **Returned precision:** relevant returned slots / all actual returned slots, over all queries. This is **not padded P@5**. An always-empty arm has undefined precision, not 100%.
- **Recall@5:** relevant returned pairs / all labeled relevant pairs (micro-averaged, answerable queries only).
- **Hit@1, MRR@5, binary nDCG@5:** answerable queries only; empty/missed positives score zero.
- **No-answer false-positive rate:** fraction of the 13 no-answer queries returning anything. Empty results are desirable here.
- Also retain raw irrelevant-result counts, missed-positive-query counts, split-level metrics, every ranked result, and fuzzy corrections.
- Timings are warmed ranking-only p50/p95 over 20 passes × 40 queries. They exclude project filesystem validation, MCP transport, startup and indexing for every arm. They are tiny-corpus diagnostics, not a scalability benchmark; run order/JIT/machine load can move them.

A separate controlled probe searches a single eligible SQLite memory before and after adding 50 **out-of-scope** documents. This tests whether current normalized scores can be interpreted as stable relevance confidence. The query and eligible record never change.

## Limits and next validation

This is a small synthetic English set, not production truth. Labels were authored once, without human adjudication. Typo cases retain other useful lexical words; they do not establish recall gains for isolated misspelled identifiers. Cross-project `all` is represented by only one eligible shared record. No large-corpus, multilingual, technical punctuation (`C++` versus `C#`), adversarial content, or temporal update benchmark is present. Single-term identifiers are represented but broad single-term queries cannot support strong intent inference.

Before shipping: privately recover a consented sample of historical queries/results (logs alone omit query text); adjudicate relevant and no-answer examples; separate development from untouched evaluation by task/session; measure precision/recall and abstention curves; preserve scope/status/dedupe contracts; add production regression tests; and bump the package version for a measurement-relevant server change. A lexical cutoff will inevitably lose useful paraphrases and partial answers unless improved further.
