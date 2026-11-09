# Memento

Memento is a cloud-only memory layer for coding agents, exposed over authenticated
[MCP](https://modelcontextprotocol.io/) Streamable HTTP. Your laptop and VMs use
the same remote memory store; losing a local checkout does not remove it.

It preserves durable context that does not belong in a repository: recurring
debugging patterns, cross-project relationships, decision rationale, product
constraints, and workflow quirks. It is not a task tracker or a secret manager.

## Architecture

One Node service on Render serves MCP, login, and account management. A persistent
disk holds the authoritative auth database and a separate store per account:

```text
MEMENTO_DATA_DIR/
  auth.sqlite                 # identities, sessions, OAuth authorizations
  accounts/<account-id>/
    memories/                 # authoritative Markdown records
    projects/                 # authoritative Markdown records
    index/                    # rebuildable SQLite FTS5 index
    config.json               # optional account retention/search settings
    logs/                     # content-free tool telemetry
```

Google/GitHub sign-in admits only verified addresses from the private
`AUTH_ALLOWED_EMAILS` environment variable. Separate work/personal accounts have
separate storage, including their global memories. Tokens—not tool arguments—select
the account. There is no local hosting product mode, offline fallback, or sync.

Existing memory/project tool contracts, deduplication, provenance, and search
behavior are preserved. See [memory policy](docs/memory-policy.md) and
[search behavior](docs/search.md).

## Connect an agent

1. Open your deployment URL and sign in with an allowlisted account.
2. Add `https://<your-service>/mcp` as a **remote Streamable HTTP MCP server** in
   your client. Use its OAuth connection flow; authorize the intended account.
3. Repeat on another VM using the same account to access the same memories.

Client configuration syntax varies. For clients accepting this JSON shape:

```json
{
  "mcpServers": {
    "memento": {
      "type": "http",
      "url": "https://memento.example.com/mcp"
    }
  }
}
```

No command/args entry or local memory directory is needed. Revoke connected
clients from the account page. Signing out of the browser does not revoke MCP
consent. The two accounts should use separate client profiles/authorizations;
there is no account-selection tool argument.

Print the canonical agent guidance with `node dist/main.js instructions` (or
`instructions --server`). Add the fragment to your global `AGENTS.md` so agents
know when to search and capture memory.

## Deploy and migrate

[Deployment guide](docs/deployment.md) covers Render configuration, private
credentials, provider callbacks, verification, and one-way import of an existing
Markdown store. `render.yaml` defines **one paid service with one persistent disk**.
No real email addresses or credentials belong in this public repository.

Disk-backed Render services have brief deployment downtime and cannot scale to
multiple instances. Data persists across restarts/deploys only beneath the mount.
There is no backup or recovery system implemented by Memento.

## Retention and privacy

The existing retention defaults still apply: active memories unread for 90 days
are archived; archived memories are permanently deleted after another 90 days
without an explicit read. Cloud hosting does **not** make every memory permanent.
Account `config.json` can override `memory_archive_after_days` and
`memory_delete_after_days` with positive integers up to 365000.

Explicit reads persist access timestamps; search, edits, and deduplication do not.
Maintenance runs only before searches. Reading a decay archive restores it;
reading a manual archive resets its deletion grace without restoring it. See the
[memory policy](docs/memory-policy.md#10-status) for details.

Tool logs contain timings, counts, vocabulary, client versions, and opaque IDs,
not queries, memory bodies, titles, or filesystem paths. Disable account logging
with `{"logging_enabled": false}` in its config. Auth credentials and allowlists
are environment-only. Provider access/refresh tokens are not retained.

## Development

Node >=22.16 supports the core SQLite FTS5 engine; production and CI pin Node
24.22.1. Bun 1.4.4 manages dependencies and scripts. The server runs on **Node**,
not Bun (`node:sqlite` is required).

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs lint, formatting checks, all three typecheck/test suites, and the
production build. Tests use temporary fixture stores and mocked provider traffic;
they need no real credentials and do not launch paid agent sessions.

For service development, use the same authenticated HTTP application with
explicit environment configuration. Non-production permits a loopback HTTP
origin; there is no authentication bypass or default local memory home.
Use `node --env-file=.env dist/main.js serve` to load a private development env file.

The optional [retrospective workflow](docs/retrospection.md) can evaluate history
and resolve projects over authenticated HTTP. Direct local promotion is removed;
remote promotion/reconciliation is currently unavailable. Paid
[harness execution](docs/harness-spec.md) is also disabled until remote fixture
isolation and evidence collection exist. Offline tests, reports, and historical
scoring remain available. `bun run report -- --snapshot <directory>` opens a
read-only report from an explicitly supplied offline export, never a live store.

## License

[MIT](LICENSE)
