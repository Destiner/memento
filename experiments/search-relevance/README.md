# Search relevance study (offline, 2026-11-09)

Read [FINDINGS.md](FINDINGS.md) for the research, historical analytics, measured results, and recommendation.

This is a **research prototype**, not a server change, shipping recommendation benchmark, or usage-propensity harness run. It needs no model, API key, new package, or network. It never opens the live Memento home. Do not use these synthetic scores as production relevance estimates.

## Reproduce

From the repository root, with dependencies installed and Node >=22.5:

```sh
node --import tsx experiments/search-relevance/run.ts /tmp/memento-search-results.json
bunx tsc -p experiments/search-relevance/tsconfig.json
```

The script writes the synthetic seed as canonical memory markdown and registers synthetic projects under a new OS temporary directory. It rebuilds an **in-memory** production index from those files, validates all baseline results through `searchMemories`, evaluates prototypes using a separate **in-memory** FTS5 table, and deletes its temporary directory in `finally`. Only the explicitly supplied output path persists. No MCP server or agent session is launched. The existing propensity harness, result logs, scenarios, and production source remain untouched.

`results.json` is the retained initial run. Reproduce to another path rather than overwriting this evidence. The output records source commit, seed hash, runtime versions, per-query hits, aggregates, and timing. Source commit identifies the baseline; experiment files are uncommitted at initial execution.

## Fixed experiment design (written before first execution)

An independent author supplied **40 memories and 40 queries** before seeing any ranker outputs. Memories include two projects, global scope, a cross-project record, two archived records, and near-topic distractors. Queries have exhaustive synthetic binary relevance labels and explanations. There are 27 answerable queries (34 relevant query/document pairs) and 13 no-answer queries. Multi-clause questions deliberately allow a useful partial answer. The development/heldout split is diagnostic: both use one corpus and several paired scope/status cases, so it is **not an independent validated holdout**. No tuning or label edits based on heldout scores are allowed.

All methods return **up to five**, with the same scope/status eligibility. All stored records use the same timestamp to avoid recency confounding. Production includes its real metadata adjustments; alternatives intentionally ablate those adjustments rather than claiming a clean one-factor causal comparison. Production BM25 and prototype BM25 see the same whole corpus, with eligibility filters before candidate limiting. Prototypes use a 30-document candidate pool; current uses its actual default pool of 30. This corpus cannot test larger-pool starvation.

### Arms

| Arm | Fixed recipe |
| --- | --- |
| `current` | Unmodified `MemoryIndex.search`; cross-checked against the production `searchMemories` operation. |
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
