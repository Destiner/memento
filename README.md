# Memento

Memento is a local, file-owned memory layer for coding agents. It runs as an
[MCP](https://modelcontextprotocol.io/) server and gives compatible agents a
shared place to preserve durable context that does not belong in any one
repository.

Memento is designed for knowledge such as recurring debugging patterns,
cross-project relationships, decision rationale, product constraints, and
workflow quirks. It is not a replacement for repository documentation, a task
tracker, or a secret manager.

## Features

- Human-readable Markdown files are the source of truth.
- SQLite FTS5 provides a rebuildable, model-free search index; weak matches can
  return fewer results or none rather than filling the requested limit.
- Memories can be scoped to one or more registered projects or marked global.
- Provenance and verification are explicit.
- Deduplication, archival, and project resolution are built into the tool
  contracts.
- Local event logging records usage metadata, never memory or query content.
- An optional retrospective pipeline can identify memory opportunities in
  Claude Code and Codex histories.

See [the memory policy](docs/memory-policy.md) for the complete storage and
usage boundary. [Search behavior and limits](docs/search.md) describe lexical
ranking, exact references, scope boundaries, and what result scores mean.

## Requirements

- Node.js 22.16 or newer (earlier Node SQLite builds lack FTS5)
- [Bun](https://bun.sh/) for installing dependencies and running development
  commands

The server itself runs on Node.js because it uses `node:sqlite`.

## Installation

```sh
git clone https://github.com/Destiner/memento.git
cd memento
bun install
bun run build
```

Configure your MCP client to launch the built server over stdio. Adapt this
example to your client's configuration format:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/absolute/path/to/memento/dist/main.js"]
    }
  }
}
```

Memento also ships an agent-instruction fragment describing when and how to use
memory:

```sh
node dist/main.js instructions
```

Add that output to your global `AGENTS.md` so agents can use Memento
proactively. Use `instructions --server` to print the shorter MCP server
instructions instead.

## Data and privacy

Memento stores data locally under `~/.memento` by default. Set `MEMENTO_HOME` to
use another directory.

- `memories/` and `projects/` contain the authoritative Markdown records.
- `index/` contains the derived SQLite search index.
- `logs/` contains local usage telemetry when logging is enabled.

The event log contains timing, counts, controlled vocabulary, client versions,
and opaque record IDs. It does not record queries, titles, memory bodies,
archive reasons, or filesystem paths. Logging can be disabled in
`~/.memento/config.json`:

```json
{
  "logging_enabled": false
}
```

The optional retrospective workflow is separate from normal server operation.
It can send redacted, bounded session context to a Claude Code or Codex
evaluator, but only when explicitly run with `--allow-remote`. Review
[the retrospection guide](docs/retrospection.md) before using it with sensitive
histories.

## Memory lifecycle

By default, active memories unread for 90 days are archived; archived memories
are permanently deleted after another 90 days without an explicit read. Override
either interval in `$MEMENTO_HOME/config.json` (default `~/.memento/config.json`):

```json
{
  "memory_archive_after_days": 90,
  "memory_delete_after_days": 90
}
```

Both fields must be positive integers, at most 365000 days. Every successful
explicit `get_memory` persists `last_accessed_at`; search, dedupe, edits, and
internal reads do not count. Missing access timestamps fall back to `created_at`.
Reading a decay archive automatically restores it. Reading a manual archive
leaves it archived but restarts its deletion grace. Explicit restore through
`update_memory` clears `archived_at` and `archive_source` (`manual` or `decay`).
Deletion grace starts at the later of archive time and last explicit read.

Maintenance runs at startup, hourly while the server runs, and before searches;
there is no standalone daemon. A direct get before a sweep can rescue an
existing record. Newly decayed archives receive the actual sweep timestamp and
cannot be deleted in the same sweep. Legacy archives without `archived_at`
receive a fresh full deletion grace on first maintenance.

Search excludes archives unless `include_archived: true`; the optional `status`
filter only narrows results and never overrides this flag. Agents must still
provide a reason for manual archival and have no hard-delete tool, but automated
retention permanently removes expired records.

## Development

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

Additional suites:

```sh
bun run typecheck:retrospective
bun run test:retrospective
bun run typecheck:harness
bun run test:harness
```

The experiment harness can launch real agent sessions and consume paid quota.
See [its specification](docs/harness-spec.md) before running it.

## License

[MIT](LICENSE)
