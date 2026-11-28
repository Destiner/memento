# Offline Cloudflare migration snapshot

Use Node 22.16 or newer from this checkout. Stop the Node service and all other
writers, cleanly close its SQLite database (checkpoint the WAL), and stage a
private, service-owned copy. The exporter takes the Node service lock on the copy
and rejects auth SQLite sidecars rather than silently dropping uncheckpointed
transactions. Do not copy a live data directory or use one writable by other
processes. Use real absolute paths (on macOS, use `/private/tmp` rather than
`/tmp`). No production credentials or data belong in fixtures or the checkout.

Set `MEMENTO_DATA_DIR` to the frozen copy, `MEMENTO_PUBLIC_ORIGIN` to the same
canonical origin that issued the grants, and `MEMENTO_SNAPSHOT_FILE` to a new
path in a private directory outside the source. Run:

```sh
node --import tsx scripts/cloudflare-export.ts
```

The exporter writes a private 0600 file without replacing an existing path; it
prints no data or counts. Alternatively, unset `MEMENTO_SNAPSHOT_FILE` and pass
`--stdout` for an intentional binary-mode pipe to the approved sealing tool;
never send it to a terminal, shell substitution, logs, or command arguments.
The v1 UTF-8 JSON is plaintext sensitive material (including browser sessions,
token hashes, encrypted client secrets and private documents), not a backup
format. Store and transfer it only through the approved private workflow.

The envelope is `{version: 1, origin, auth, accounts: [{id, documents}]}`.
`auth` maps the fixed v1 SQLite table names to arrays of rows, with `auth.user`
providing the account IDs. Row cells preserve SQLite storage classes (including
integer and BLOB tags). All auth tables, including transient rows, transfer
unchanged. Exactly one `${origin}/mcp` resource row is required. Only when the
canonical origin is exactly `https://memento.destiner.io` may the snapshot also
contain one `https://memento-o9bz.onrender.com/mcp` resource row. No other resource
rows are accepted. The historical row and grants are preserved without rewriting;
that audience does not authenticate at the canonical MCP endpoint.

Every user is included, including auth-only users with empty
`documents`; a disk account without an auth user is rejected. An unreferenced
registered project is valid, but memory-to-project references must resolve in
the same account. Filenames and bytes of validated UTF-8 Markdown/config are
preserved; search indexes, lock databases, logs and dashboard files are not
exported. The raw plaintext limit is 16 MiB; the encrypted envelope adds exactly
36 bytes. The snapshot admits up to 128 accounts and 8,192 auth rows total, with
at most 4 MiB of compact auth JSON and 256 KiB per decoded auth text/BLOB cell.
Each account admits up to 1,024 documents, 256 KiB per document and 8 MiB of
UTF-8 contents in total. All limits apply together; one maximum-sized section
can reduce the remaining snapshot capacity.

The operator sends one auth RPC and one RPC per account, never the whole
snapshot. Each argument is checked against a conservative 24 MiB size estimate
(two-byte strings plus framing), below the published [32 MiB serialized RPC
limit](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations).
This is a budgeting check, not a measurement of production serialization or
peak isolate memory. Auth also checks a conservative stored-row size (8,000,000
bytes including a record-header allowance). The fixed v1 auth INSERT shapes
use at most 36 bindings and 1,315 SQL bytes; the widest verification SELECT
uses 72 result columns and 6,817 SQL bytes. The account INSERT uses at most 80
bindings and 401 SQL bytes; a document is far below the SQLite row limit. Binding
payload bytes are not SQL statement text. See [SQLite DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).

Preclaim validation checks v1 auth NOT NULL, unique and foreign-key constraints,
and rejects values that would change storage class on insert. This does not
check live destination state. The destination still performs a real transaction
and durable readback; the offline exporter dry-runs in local SQLite as well.

Worker handoff: use `validateMigrationSnapshot(value, origin)` for the complete
payload and exact account membership, `validateAccountSnapshot(documents)` for
account RPC validation, and `importAuthSnapshot(storage, auth, origin)` for the
**auth member**, returning literal `true` only after durable read-back. Ready
and normal ingress must remain gated during the migration. Call
`markAuthIngressStarted(storage)` from the Auth DO before first normal auth
traffic (only after maintenance mode has ended); this permanently closes the
import window even on a target that never held users. A fresh bootstrap resource
row at the same URL is the only permissible existing auth row; it is replaced
with the source resource, including its original ID and timestamps. The target
must use the same canonical origin and Better Auth secret. Do not forward
parser/SQLite error details or expose import on a fetch route.

Auth and each account DO commit independently. Keep traffic blocked until the
operator has verified the complete run. Do not retry over a partial restore;
use an approved pristine target. The exporter and automated tests make no
production IO or remote calls.
