# Search evaluation tools

Offline checks for [Memento's lexical search](../../docs/search.md). Run commands
from the repository root after `bun install`, using Node >=22.16. These tools use
synthetic or explicitly supplied fixtures, never the live Memento home, and need
no model, credentials, or network.

## Checks

```sh
bunx tsc -p experiments/search-relevance/tsconfig.json
bunx vitest run --config experiments/search-relevance/vitest.config.ts
bunx vitest run test/integration/search-quality.test.ts
```

The experiment suite checks fixture validation, metrics, private output handling,
and the frozen comparison baseline. The integration test enforces production
precision, recall, and no-answer regression budgets. The root test suite includes
the integration test but not the experiment suite.

`seed.json` and `holdout.json` are both regression fixtures, **not untouched
holdouts**. Future shipping decisions need independently authored evaluation
cases kept out of tuning. Do not run private fixtures without permission.

## Compare an explicit corpus

```sh
node --import tsx experiments/search-relevance/compare.ts \
  experiments/search-relevance/seed.json /tmp/memento-search-comparison.json
```

`compare.ts` evaluates exactly the supplied full corpus; it never discovers other
fixtures or selects a live store. The current arm creates disposable Markdown and
project records, rebuilds an in-memory production index, and calls `searchMemories`.
Returned IDs and rounded scores are checked against the raw production index.
Both arms apply scope, type, and status filters and return at most five results.
Splits share the same full corpus, not separate indexes.

`legacy-*.ts` is a self-contained, frozen 0.4.0 comparison baseline. Do not sync it
with production. `results.json` supplies its expected rankings and scores to
`evaluation.test.ts`; it is a test fixture, not a current performance report.
SQLite runtime upgrades can still change native behavior, which this test detects.
`run.ts <output.json>` runs the alternative lexical recipes against `seed.json`;
its arm named `current` uses the frozen baseline, not current production. Use
`compare.ts` to evaluate production changes.

### Fixture format

The input contains:

- `version` and `projects: [{id, name}]`;
- `memories: [{id, title, description, body, scope, type, status?, verification?}]`;
- `queries: [{id, query, scope, relevant, types?, status?, split?, category?, rationale?}]`.

`relevant` lists all relevant memory IDs, even when there are more than five.
Status defaults to active, project matching to `any`, and omitted splits to
`unspecified`. Invalid records, duplicate IDs or labels, missing project references,
and labels outside the query's eligible scope/types/status fail validation. See
`evaluation.ts` for the schema.

### Metrics and interpretation

- **Returned precision:** relevant returned pairs / actual returned slots, without
  padding short responses.
- **Micro recall@5:** relevant returned pairs / all relevant labels.
- **Capped attainable recall@5:** relevant returned pairs / sum of
  `min(5, relevant labels per query)`; this is not full-label recall.
- **nDCG@5:** binary ranking quality over answerable queries, including zero for
  misses.
- **No-answer false-positive rate:** no-answer queries returning anything / all
  no-answer queries. A separate rate excludes empty metadata-eligible pools,
  which cannot test ranking discrimination.

Reports also retain per-query hits, misses, absolute counts, input and normalized
hashes, source commit, and runtime versions. Undefined ratios are `null`, not a
perfect score. Query IDs appear in outputs, not query text or rationale, but
outputs may still be sensitive. Synthetic scores are diagnostics, not production
accuracy estimates. Adding `--timing` reports cold, single-pass timings; legacy is
ranking-only while current includes project validation, so these are not a fair
latency comparison.

## Scale and MCP verification

```sh
bun run build
node --import tsx experiments/search-relevance/smoke.ts /tmp/memento-search-smoke.json
node --import tsx experiments/search-relevance/scale.ts /tmp/memento-search-scale.json
```

`smoke.ts` launches `node dist/main.js` over MCP stdio in a disposable home. It
creates synthetic memories, runs positive and unrelated searches, and verifies
four successful tool calls and content-free diagnostics in the isolated event log.
A transcript alone is not proof that a call reached the server.

`scale.ts` checks deterministic 1,000- and 5,000-record corpora, including crowded
identifier-prefix decoys and missing exact targets. It measures ranking only,
excluding index construction, filesystem validation, and MCP transport. There is
one warmup and three samples per query/ranker: reported p95 is the maximum of three
samples, not a production tail-latency estimate.

All output paths must be new and outside the repository. Tools refuse overwrites,
symlinks, and repository paths, write mode-0600 files, and clean temporary stores
and indexes on exit. Do not commit generated evaluation reports or private data.
