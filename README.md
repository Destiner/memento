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
- SQLite FTS5 provides a rebuildable search index.
- Memories can be scoped to one or more registered projects or marked global.
- Provenance and verification are explicit.
- Deduplication, archival, and project resolution are built into the tool
  contracts.
- Local event logging records usage metadata, never memory or query content.
- An optional retrospective pipeline can identify memory opportunities in
  Claude Code and Codex histories.

See [the memory policy](docs/memory-policy.md) for the complete storage and
usage boundary.

## Requirements

- Node.js 22.5 or newer
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
