# Search relevance: findings and recommendation

Research date: **2026-11-09**. Baseline: Memento **0.4.0**, commit `c0cd93a80ccc382f4b1a4f6f104597a12a169cc0`.

## Recommendation

**Keep SQLite FTS5 for now. Improve the decision to return a memory, not just its ordering. Do not ship the prototype thresholds unchanged.**

The current backend already finds most useful memories in this synthetic study, but fills the rest of the response with weak matches. Adding a second lexical retrieval channel did not fix that. A relevance gate removed the observed noise, but a blunt whole-query coverage gate also lost important exact-identifier, paraphrase, and multi-part answers. There is useful model-free work to do before adding an embedding model or switching engines.

No production source, dependencies, or policy were changed. The ordinary project-resolution/search calls at investigation start created normal telemetry; historical analysis below excludes those calls. The experiments and log audit did not open or modify live memory documents or index files: experiments used disposable markdown seeds and in-memory databases only.

## 1. Current search and likely cause

Relevant implementation:

- [`src/store/index-schema.ts`](../../src/store/index-schema.ts): SQLite FTS5 with `porter unicode61` over title, description, and body.
- [`src/store/search-index.ts`](../../src/store/search-index.ts): BM25, candidate retrieval, metadata adjustments, scope filters, and dedupe candidate retrieval.
- [`src/store/memory-search.ts`](../../src/store/memory-search.ts): project validation, active-only default, limit clamping, and summary response.
- [`test/integration/retrieval.test.ts`](../../test/integration/retrieval.test.ts): acceptance primarily checks expected-memory presence in the top three, not irrelevant-result volume or no-answer behavior.

There is **no separate search package**. Search is implemented on Node's built-in `node:sqlite`.

The current sequence:

1. Lowercase and split the query into words; discard one-character terms. No stop-word removal or deduplication.
2. Join **every** term with `OR`. One generic word is enough to qualify.
3. Get up to `max(limit × 5, 30)` BM25 candidates, scope/status/type filtered.
4. Normalize BM25 as `relevance / (relevance + 1)`.
5. Add **0.12** for any title term match, **0.10** for any description term match, and **0.05** for active status; penalize archived by **0.40** and unverified by **0.08**.
6. Sort, clamp exposed scores to `[0,1]`, and return the requested number when available. **There is no minimum relevance requirement.**

This explains why a precise hit can be followed by unrelated memories matching “does,” “use,” or “request.” The binary title/description boosts reward a single generic term just like a discriminative term. Their JS matching also does not use the stemmer used by candidate retrieval. These are source-level mechanisms; the study below reproduces their combined effect, rather than attributing a causal percentage to each one.

### The existing score is not confidence

A controlled probe searched `SQLite` with one eligible memory. Adding 50 **out-of-scope** pottery memories changed its score from **0.1700 to 0.8823**, without changing the query or sole eligible result. FTS5 corpus statistics are computed over the FTS table, not the SQL-filtered project pool. This is not a scope leak: wrong-scope memories are still excluded from results.

In the seed run, **75/169 returned scores were exactly 1**, including **47 irrelevant results**. The ranker sorts by the pre-clamp value, but the response compresses distinct ranks to the same score. A threshold like “only return score >0.7” would not be a sound confidence policy.

SQLite's own implementation floors non-positive term IDF to `1e-6`, so metadata additions can dominate lexical evidence on small/common-term corpora. See [SQLite implementation](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_aux.c) and [BM25 documentation](https://www.sqlite.org/fts5.html#the_bm25_function).

## 2. Historical analytics: available, but not relevance labels

Read-only analysis of local `~/.memento/logs/events-*.jsonl`, retaining events **before 2026-11-09 10:38:00 UTC** to exclude this investigation. Observed historical range: **2026-10-05 14:03:50 through 2026-11-09 10:30:18 UTC**. There were 449 historical events, 105 server-process sessions, and no malformed JSON, duplicate event IDs, or search result-count/ID mismatches in this read.

| Measure | All historical clients | Pi clients only |
| --- | ---: | ---: |
| Searches | 169 | 147 |
| Empty searches | 71 / 169 (42.0%) | 71 / 147 (48.3%) |
| Nonempty searches | 98 | 76 |
| Nonempty searches with a later matching memory read | 64 / 98 (65.3%) | 52 / 76 (68.4%) |

**22 searches came from migration/verification clients**, so the Pi subset is a better usage description. All events reported server `0.4.0`, policy `2.2.0`, and variant `shipped-v2`; there is no version-controlled search-algorithm contrast.

All-client result-count distribution: 0→71, 1→27, 2→54, 3→1, 4→12, 5→1, 8→1, 10→2. All 68 successful memory reads matched a preceding search result in the same process session. Attributing each read to the latest matching search gives **55 rank-one opens, 12 rank-two opens, and 1 rank-three open**. Three reads had more than one possible preceding search. The dashboard-style 64/98 rate allows a read to activate multiple earlier matching searches.

The logs keep **query ID, query length, ordered result IDs, result count, scope, and subsequent reads**. They intentionally omit **query text, historical returned text, scores, filter values, requested limit, and usefulness judgments**. Therefore they cannot establish historical precision, recall, or semantic relevance. An opened memory can be useless; an unopened summary can already answer a need. Session IDs describe server-process lifetimes, not necessarily one task, and the matching has no time bound.

No private transcripts or live memory bodies were used for this study, and no private content was submitted to search providers. Local Pi configuration points at this checkout's server without a home override, consistent with the local store; that does not prove every other MCP client uses this same store. Replaying recovered queries against today's corpus would measure today's retrieval, not reconstruct historical results.

## 3. Isolated seed experiments

See [method and reproduction instructions](README.md), [seed and judgments](seed.json), [runner](run.ts), and [retained output](results.json).

- 40 entirely synthetic memory documents; two projects plus global scope, cross-project membership, and archived records.
- 40 independently authored queries: **27 answerable, 13 no-answer**, with **34 relevant query/document pairs**.
- Exact identifiers, body-only matches, stemming, typo queries, paraphrases, multiple useful memories, near-topic distractors, absent vendors, and scope/status boundaries.
- All arms return up to five; baseline runs the unmodified production index and is cross-checked through `searchMemories`.
- Fixed weighting, three prespecified cutoff levels, typo correction, and reciprocal-rank fusion (RRF) were evaluated without tuning to outputs.

### Results across all 40 queries

“Precision” here is relevant hits divided by **actual returned hits**, not a padded five-slot P@5. Recall is over the 34 labeled relevant pairs. No-answer FP counts queries returning anything when no eligible useful memory was labeled.

| Method | Useful hits / 34 | Irrelevant hits | Returned precision | Recall@5 | No-answer FP / 13 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current production | 32 | 137 | 18.9% | 94.1% | 13 |
| Clean query + weighted BM25 | 33 | 104 | 24.1% | 97.1% | 12 |
| Above + 40% weighted term coverage | 26 | 0 | 100% | 76.5% | 0 |
| Above + 60% coverage | 14 | 0 | 100% | 41.2% | 0 |
| Above + 80% coverage | 6 | 0 | 100% | 17.6% | 0 |
| Conservative typo correction + 60% coverage | 16 | 0 | 100% | 47.1% | 0 |
| BM25 + character-trigram RRF, ungated | 33 | 147 | 18.3% | 97.1% | 13 |
| Same RRF + 60% coverage | 14 | 0 | 100% | 41.2% | 0 |

These are **synthetic diagnostic results, not a claim of 100% production precision**. The 40% cutoff still entirely misses **5/27 answerable queries** and loses eight relevant pairs. On the diagnostic heldout subset it gets 13/16 relevant pairs, versus current's 15/16; the same tradeoff is visible rather than hidden by pooling. The heldout shares a corpus and paired cases and is not an independent ship-quality holdout.

Warmed ranking-only p50s were **0.25–0.35 ms**, p95s **0.44–0.58 ms**, on this 40-record corpus. This excludes disk validation, MCP transport, startup and indexing; it establishes only that no model/network is needed for these small prototypes, not production scalability or a performance winner.

A repeat execution reproduced every result order, score, aggregate, seed hash, and score probe exactly (excluding timing and generation timestamp).

### Representative cases

**Noise from generic query words:** `What does digestBucketZone control?` found the right body-only identifier, but production also returned CSV formula safety, proration, Vite origin, and contact accent matching. The cleaned/weighted arm returned only the intended memory. Its evidence fraction was 0.416, however, so the stricter 60% gate rejected even this excellent identifier match.

**Missing subject:** a Mailgun suppression-list synchronization query returned five memories under production, led by the Postmark provider choice. The 40% gate returned nothing. This is a useful abstention example under the seed's direct-answer rubric, though a human could regard the Postmark choice as useful premise-correction evidence.

**Multi-part needs:** asking both which service delivers invitations and how to avoid repeats after crashes has two complementary answers. Neither covers 40% of the whole query, so both are rejected. A single whole-query fraction is the wrong abstraction for some multi-part questions.

**Paraphrase tradeoff:** the database socket-budget paraphrase is correctly ranked first by production and weighted BM25, but rejected at 40% coverage. The stale-autosave paraphrase is missed by every arm. Lexical-only methods still have a semantic recall ceiling.

**Historical requests:** an explicit active+archived search for the retired importer's timeout misses the correct archived result under production. Weighted BM25 ranks it first. The large unconditional archived penalty deserves a separate ablation; this study changes several other factors at once and cannot assign sole causality to that penalty.

**Fuzzy correction failure:** even the unique one-edit rule changed correctly spelled `stage → state` and `remain → retain` in ordinary queries. Absent from this corpus does not mean misspelled. The two recovered typo cases do not justify silently rewriting arbitrary identifiers or ordinary words.

**Post-hoc limit-only comparator:** truncating existing production responses to one result reduces irrelevant returned slots from 137 to 15, but useful pairs from 32 to 25, and still returns something for **all 13 no-answer queries**. A smaller default limit reduces clutter, not false-positive answers. This was a diagnostic calculation after the fixed experiment, not an original arm.

### Important limits

- Synthetic queries are longer than historical usage: seed median **86** characters versus historical median **63**. Compound questions are deliberately represented. Precision/recall tradeoffs need real-query validation.
- Binary labels require a direct useful answer. Some negative cases have memories that could challenge a false premise (“exact lookup, not semantic search”). Human review should decide how to count these before selecting a threshold. Labels were not changed in response to results.
- `weighted` bundles stop-word removal, term deduplication, field weights, and removal of metadata adjustments. It is not an ablation isolating each effect.
- No package replacement, embedding model, multilingual corpus, large corpus, punctuation-sensitive technical identifier benchmark, or production task outcome was tested.

## 4. Cheap/local options researched

| Option | What it offers | Assessment for this problem |
| --- | --- | --- |
| **Existing FTS5, improved lexical policy** | Porter stemming, column-weighted BM25, phrases/NEAR, vocabulary tables; no added runtime package/model | Best next step. Existing retrieval is reasonably good at finding answers; result acceptance is missing. Phrase/proximity and identifier-aware evidence are candidates for follow-up, not tested wins here. |
| **MiniSearch** | In-process, zero external dependencies; BM25+ scoring, field boosts, prefix search, edit-distance fuzzy search; configurable term processing | Credible lightweight replacement if fuzzy search ergonomics become important. It still needs a relevance/abstention policy; its default has no stemming or stop-word list. Not benchmarked here, and no evidence justifies migrating the authoritative/derived-index plumbing yet. |
| **BM25 + character n-grams, fused with RRF** | Model-free combination of word and spelling/substring evidence | Tested an explicit JS trigram-Dice channel. It added noise, not a precision improvement. Both channels are lexical; they are not independent semantic evidence. |
| **Conservative typo fallback** | Recovers misspellings without a model | Potential later feature, but constrain it and preserve original exact matches. The tested replacement rule already rewrites valid words incorrectly. |
| **Dense or learned sparse semantic retrieval** | Could recover vocabulary-mismatch paraphrases | A different capability, not a fix for returning weak candidates. Defer model/runtime/deployment cost until real-query misses show its value. “Sparse” is not automatically model-free. |

Primary references, accessed 2026-11-09:

1. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html): BM25 weighting, Porter, phrase/proximity syntax, vocabulary tables, and trigram behavior. **FTS5 trigram is substring matching, not an edit-distance typo engine.**
2. [SQLite BM25 implementation](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_aux.c): whole-table statistics and the `1e-6` IDF floor.
3. [MiniSearch documentation](https://lucaong.github.io/minisearch/), [search options](https://lucaong.github.io/minisearch/types/MiniSearch.SearchOptions.html), and [BM25+ parameters](https://lucaong.github.io/minisearch/types/MiniSearch.BM25Params.html).
4. [Elastic: hybrid retrieval and RRF experiments](https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid): explains why complementary retrieval signals can help and why performance should be measured on the target data. Its lexical+semantic results are not evidence that our lexical+lexical fusion should help, and RRF is not an absolute relevance threshold.

## 5. Proposed next change—not implemented

1. **Create a small adjudicated real-query set.** Recover a consented local transcript sample to obtain query text, task context and exposed results, joined by query ID where available. Keep private text out of the repository and external research tools. Separate development/evaluation by task or session, not random query paraphrase.
2. **Separate retrieval from acceptance.** Keep broad FTS candidate generation, but return fewer or zero memories when query evidence is weak. Protect exact technical identifiers and body-only matches; consider matching coherent clauses/phrases rather than forcing every useful memory to cover a whole compound query. Do not discard missing vendor/subject terms from the acceptance calculation.
3. **Ablate the cheap changes separately.** Query normalization, term-aware field weighting, metadata tie-breakers, archived intent, and acceptance gate should have separate comparisons. Avoid using current normalized BM25 as a global confidence threshold. Do not allow status/verification metadata to rescue a lexically irrelevant candidate.
4. **Measure noise and lost answers together.** Add no-answer FP rate, actual returned precision, recall, multi-answer completeness, and exact-identifier regressions alongside top-k recall. Test scope/type/status and dedupe candidate behavior independently. Search and create-memory dedupe currently share helpers: tightening search must not silently shrink dedupe recall.
5. **Only then consider fuzzy/semantic expansion.** Preserve originals, penalize expansions, and require independent evidence before accepting fuzzy-only results. If paraphrase misses remain material, evaluate optional semantic retrieval rather than assuming that adding another lexical channel is equivalent.

For future diagnostics, a privacy-preserving opt-in event extension could retain requested filter values/limit, ranker version, raw lexical evidence, coverage and matched-field/term counts. It would improve explainability but still not supply intent or relevance labels. Query text/result snapshots need a separate explicit retention policy; a query hash alone cannot recover intent. Any measurement-relevant production change should bump the package version, and any index/tokenizer shape change should bump the index schema version.

## Validation

- Experiment-specific TypeScript check passed.
- Repository typecheck, build, ESLint, and changed-code/data Prettier checks passed.
- Existing suite: **40 test files, 567 tests passed**.
- Independent review reproduced all 40 production rankings and scores and independently checked coverage and aggregate metrics. It found no result-invalidating implementation error and highlighted the fuzzy correction, exact-identifier, archived-intent, and judgment-rubric limitations above.
