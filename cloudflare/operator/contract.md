# Private operator integration contract

The operator binds directly to two SQLite Durable Object classes in the main
Worker. It never calls the main Worker over HTTP.

| Binding and instance name | Internal RPC | Successful return |
| --- | --- | --- |
| `MEMENTO_AUTH` → `AuthObject`, `idFromName('auth-v1')` | `importSnapshot(auth)` | Literal `true` after checking the target's configured resource/origin, committing atomically to fresh storage, and verifying persisted auth rows. |
| `MEMENTO_ACCOUNTS` → `AccountObject`, `idFromName(account.id)` | `importDocuments(documents)` | Literal `true` after serializing against normal operations, committing atomically to an uninitialized store, and comparing all persisted paths and contents. |

The `auth` argument is the auth member of the exporter envelope. The shared
snapshot validator requires set equality between `auth.user[*].id` and
`accounts[*].id`, with an empty document list for users with no source directory.
It validates the exact canonical origin and requires the `${origin}/mcp` resource.
For the production-only historical resource exception, wire format and auth
bootstrap rules, see [snapshot.md](../snapshot.md).

Neither method has a Fetch equivalent. The target must stay dark until an
operator verifies the complete run against the approved digest and counts.
There is no cross-DO rollback, merge, or resume. See the
[runbook](../../docs/cloudflare-migration.md) for staging, rehearsal and release.
