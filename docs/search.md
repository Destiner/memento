# Search behavior

Memento 0.5.0 uses SQLite FTS5 with Porter stemming and `unicode61` tokenization.
Search is local and model-free: no embedding model, network call, fuzzy rewriting,
or extra search dependency is required.

## Finding and accepting results

`search_memories` still requires explicit scope. Global and project scopes never
implicitly include one another; project `any`/`all`, type filters, and the default
active-only status are applied before retrieval and evidence statistics.

The requested limit is a **ceiling**, not a target. Search may return one useful
memory—or nothing—even when other memories share a generic word.

The ranker (`lexical-evidence-v1`) separates three steps:

1. **Normalize:** deduplicate query words and remove English function words.
   Missing content words remain in the query; an unsupported subject is evidence
   against returning a weak match. SQLite supplies stemming and accent handling
   for both query and document evidence.
2. **Retrieve:** gather a broad FTS5 BM25 candidate pool, with title/description/body
   weights of 4/2/1. Exact code references have a separate recovery path, so a
   long body-only identifier match is not lost behind generic title matches.
3. **Accept and rank:** measure distinct matched terms against the eligible
   scope's query-term frequencies. Require at least two content terms (one for
   a single-term query) and 30% weighted coverage, or a matching exact reference.
   Title, description and body matches contribute 1/0.9/0.75 to ranking evidence.
   Status and verification break equal-evidence ties; they cannot make an
   irrelevant memory eligible or bury an explicitly requested historical answer
   under a large fixed archive penalty.

A query can contain independent information needs. Question marks, semicolons,
newlines, and explicit transitions such as “and how” define clauses, up to eight.
A memory may answer one clause without answering every clause. Ranking combines
80% best-clause evidence and 20% whole-query evidence. Plain keyword lists and
phrases such as “cache and invalidation” are not arbitrarily split at every `and`.

## Exact references

Backticks and double quotes preserve atomic literals. Code-shaped references
such as `refreshToken`, `worker_loop`, `config.json`, `--no-cache`, or `C++` also
retain their spelling/punctuation. Multiple literals in one clause must all
match; separate questions can have different references.

Literal checks are Unicode case-insensitive with token boundaries. A path or flag
cannot match merely as the prefix of a longer path/flag (`config.json.bak`,
`--no-cache-dir`). A plain identifier may precede member access or an executable
extension (`worker_loop.sh`). Prose punctuation after an inferred reference is
ignored. Quoted content is not split at internal question marks or conjunctions.

Literal-bearing clauses require literal evidence; punctuation-stripped FTS hits
alone are insufficient. Exact matches can survive low whole-query coverage,
including body-only references. This is useful lexical evidence, **not proof that
the memory answers every contextual detail**.

## Scores and limits

Returned `score` is a bounded lexical ranking heuristic, rounded to two decimals.
It is **not calibrated confidence**, and scores should not be compared across
unrelated queries. An exact-reference match has an evidence floor of 0.85 before
clause blending. The same score can belong to multiple results.

Term-frequency evidence is scope/type/status-local. BM25 candidate selection and
BM25 tie-breaking still use SQLite's whole-table statistics, so unrelated corpus
changes can affect candidate inclusion or tied ordering. Scores are not derived
from the old saturating BM25-plus-metadata formula.

Queries are limited to **4,096 characters and 64 distinct terms**, including
actual SQLite tokenizer expansion. Oversized queries fail validation explicitly;
they are not silently truncated. Function-word-only prose returns no results;
explicit literals retain their words even when those words would normally be
ignored.

## What is unchanged

- Markdown remains authoritative; the SQLite index remains rebuildable.
- No persistent index/tokenizer schema change is needed for this release.
  Tokenizer scratch tables and vocabulary views are connection-local TEMP
  objects; reopening an existing index needs no migration.
- Scope never widens to improve recall.
- `create_memory` dedupe keeps its original broad OR query, unweighted BM25,
  candidate limit, and inclusion of archived neighbours. Search abstention does
  not tighten the write-time duplicate gate.
- Search returns summaries, not memory bodies.

## Diagnostics and privacy

When existing local logging is enabled, search events additionally record the
ranker version, ordered returned scores, effective limit, and validated type/status
filters. These are optional additions to log schema 2; old events remain readable.
Query text, terms, exact literals, memory titles and bodies are never logged. The
scores help diagnose changes but still do not establish relevance judgments.

## Known limits

This is lexical search, not semantic entailment. Paraphrases with little vocabulary
in common can still be missed. Negation, unsupported assumptions and broad topic
lists are not fully understood. Small pools offer little frequency information;
a strong exact identifier can still have incidental context. The bounded broad
candidate pool is not guaranteed to cover every independently useful clause.
Exact-reference recovery can scan multiple batches when many prefix decoys exist.

See the [research](../experiments/search-relevance/FINDINGS.md) and
[implementation evaluation](../experiments/search-relevance/IMPLEMENTATION.md)
for the measured tradeoffs. Neither synthetic precision nor a read-through rate
is a guarantee of production relevance.
