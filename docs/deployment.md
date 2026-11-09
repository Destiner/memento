# Cloud deployment

## Topology

Deploy `render.yaml`: one paid Node web service, one instance, one 1 GiB persistent
disk mounted at `/var/data`. MCP and browser authentication share one origin.
Markdown records remain authoritative; FTS5 indexes are rebuilt when missing or
out of date. `auth.sqlite` is authoritative and must persist along with the records.

Do not add workers, autoscaling, shared-filesystem replicas, or a second service
opening this data directory. A process-level SQLite lock prevents simultaneous
serving/import processes from owning it. Render disks are available at runtime,
not during build/predeploy or one-off jobs. Auth migrations run at startup before
readiness; no data work belongs in `preDeployCommand`.

A disk means deploys briefly interrupt service. Application deploys are configured
to wait for CI; Blueprint infrastructure auto-sync is a separate path, so review
infrastructure/cost changes before pushing. A Blueprint file is configuration,
not evidence that a service has been provisioned or accepted.

## Private configuration

Use Render's secret environment configuration, not checked-in values:

| Variable | Meaning |
| --- | --- |
| `MEMENTO_PUBLIC_ORIGIN` | Exact canonical HTTPS origin, no trailing slash/path; Blueprint uses the assigned service URL |
| `MEMENTO_DATA_DIR` | Absolute path under the disk; Blueprint sets `/var/data/memento` |
| `AUTH_ALLOWED_EMAILS` | Required comma-separated exact verified email addresses; normalized to lowercase; no wildcards/domains |
| `BETTER_AUTH_SECRET` | Stable random secret, at least 32 characters; Blueprint can generate it |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Complete Google pair, or both absent |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Complete GitHub pair, or both absent |
| `PORT` | Supplied by Render; defaults to 3000 otherwise |
| `HOST` | Defaults to `0.0.0.0` in production, loopback in development |

At least one social provider pair is required. Leave the unused pair unset. The
`.env.example` contains configuration names and empty placeholders only. Do not
paste allowlisted addresses, OAuth secrets, session cookies, tokens, or real
memory exports into commits, issues, test fixtures, build output, or logs.
`MEMENTO_HOME` is rejected; there is no legacy/local runtime mode.

Changing the allowlist requires a restart/deploy. The replacement process checks
current admission on sign-in, consent, refresh and every MCP request. Removing an
email disables that user's access even with existing tokens. It does not delete
their files. Do not rotate the Better Auth secret casually: it also protects
provider state, browser sessions and confidential-client credentials.

Configure callback URLs privately in your provider apps:

- Google: `<origin>/api/auth/callback/google`
- GitHub: `<origin>/api/auth/callback/github`

Google requests OpenID/email/profile. GitHub requests `read:user user:email` and
requires a verified allowlisted address. Automatic account linking is disabled;
use the same provider for a given account. Different work/personal identities are
separate accounts and storage. No provider tokens are persisted.

If using a custom domain, change the canonical origin and provider callbacks
before connecting clients. OAuth issuer/resource identifiers are origin-bound;
changing origin requires clients to reconnect.

## MCP authorization

Endpoint/resource: `<origin>/mcp`. Issuer: `<origin>/api/auth`.

Discovery is available at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server/api/auth`. The service uses authorization
code + S256 PKCE and rotating refresh tokens, with `mcp` and optional
`offline_access` scopes. Token requests must include the exact MCP resource.
Browser cookies never authorize MCP. Each consent grants all existing memory and
project tools for that account—no per-tool permissions or shared banks.

The account page lists authorizations and offers revocation. Signing out of the
browser is distinct from revoking a client. See
[auth implementation constraints](../src/auth/README.md) for lifetimes, registration
limits and security boundaries.

Streamable HTTP is stateless JSON request/response. There are no durable MCP
sessions, GET/SSE streams, or DELETE session endpoints. Clients should reconnect
following a deploy. Request bodies are capped at 1 MiB, with bounded global and
per-account concurrency. Do not enable permissive CORS.

## Acceptance checklist

Before switching existing clients:

1. Confirm `/health` is 200 only after auth initialization succeeds.
2. Confirm unauthenticated `/mcp` returns 401 with protected-resource metadata.
3. Complete real Google/GitHub sign-in and a client's OAuth/PKCE flow.
4. Call a tool through the actual client and confirm the account event log records
   it. A claimed tool call in an agent transcript is not sufficient.
5. Connect a second client/VM to the same account; verify shared reads/writes.
6. Connect the other account; verify it cannot read/search guessed IDs from the first.
7. Revoke a client; verify subsequent calls fail. Reauthorize explicitly.
8. Restart/redeploy and confirm auth state and memory files persist.
9. Check logs contain no private body, query, email allowlist, credential or token.

Automated tests use fixture identities and mocked vendor responses. They do not
replace live provider/client/deployment acceptance.

## One-way import

Import is an explicit operator action, never sync. Create the destination account
by signing in first and note its opaque ID on the account page. Do not connect an
MCP client yet: import requires that the destination account store does not exist.
The command rejects even an existing empty store rather than merging/overwriting.

Pause old local writers. Stage the source directory privately on the persistent
disk, outside `MEMENTO_DATA_DIR`; never add it to the repository. Transfer only via
an operator-approved secure mechanism. No upload endpoint is exposed publicly.

With no server process owning the data directory, run under Node:

```sh
MEMENTO_DATA_DIR=/var/data/memento node dist/main.js import \
  --source /var/data/import-source --account <opaque-account-id>
```

On Render, the disk is runtime-only. One option is an explicitly reviewed
**temporary start command** that runs this import followed by the normal server:

```sh
node dist/main.js import --source /var/data/import-source --account <opaque-account-id> && node dist/main.js serve
```

Restore `node dist/main.js serve` after a successful import, before another restart
or deploy: the importer deliberately refuses to run again over an occupied store.
Do not run an import against the live server from a shell; the service lock rejects
it. Do not attempt import in Render build/predeploy or a one-off job.

The importer validates authoritative Markdown/config, rejects symlinks, duplicate
IDs and dangling project references, preserves filenames/IDs/timestamps, rebuilds
the index in a private staging directory, then renames it into place. It never
runs retention or modifies/deletes the source. Failures leave no partially
published store. A failed import requires correcting the source, not weakening
validation. Operators should compare counts and representative records after
import and before directing agents to the remote URL.

Remove old client command/args configurations after acceptance. There is no
fallback to the old files. Retain or dispose of old/staged data explicitly;
Memento does not delete it for you.

## Durability boundary

The mounted disk protects against losing a laptop/VM and persists through normal
service redeploys. This is not a backup/recovery system. Deleting the disk/service,
corruption, and automatic memory retention can still remove data. Retention is
unchanged: default 90 days to archive, then 90 days to delete, triggered before
searches. Configure account retention deliberately if longer preservation is
needed. Backups are outside this implementation's scope.
