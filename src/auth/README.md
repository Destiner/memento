# Cloud authentication boundary

`createAuthService(options)` is the Node-only, SQLite-backed HTTP authentication
service. Import its contract and types from `src/auth/index.ts`.

## Integration

- Construct it once, await readiness before accepting traffic, and close it on
  shutdown. Migrations run before Better Auth initializes and seeds its resource.
- Route `/`, `/oauth/*`, `/api/auth/*`,
  `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-authorization-server/api/auth`, and
  `/.well-known/oauth-protected-resource[/mcp]` to `handle`.
- The issuer is `<origin>/api/auth`; the sole resource/audience is `<origin>/mcp`.
  Protected-resource discovery advertises this issuer.
- Call `authenticate(request)` for **every** MCP HTTP request, not just transport
  initialization. Only its returned `accountId` selects account storage. It is
  the immutable Better Auth **user** UUID, never a provider subject, client ID,
  session ID or consent reference. Browser cookies do not authenticate MCP.
- Pass the secret, private email allowlist and configured social credentials from
  deployment configuration/environment. This module reads no credential files
  or environment allowlist defaults. Do not expose these options to browsers.
- Configure provider callbacks as `<origin>/api/auth/callback/google` and/or
  `<origin>/api/auth/callback/github`. At least one provider is required.

## Policy and operating constraints

Only verified, currently admitted emails can sign in, approve consent, redeem
codes/refresh tokens, or authenticate MCP. Emails are trimmed/lowercased in the
configured allowlist and compared to normalized verified provider emails. Change
the configured allowlist by recreating the service; existing bearer credentials
are checked against the replacement policy immediately. Automatic account
linking, public password signup and client/resource administration are disabled.
Provider tokens are discarded instead of persisted.

Authorization code and refresh grants require the exact resource indicator;
authorization requires S256 PKCE and `mcp`, with optional `offline_access`. Access
tokens last five minutes, codes one minute, and rotating refresh tokens thirty
days. Reusing a rotated refresh token invalidates its family, with no replay
grace period. Access/refresh tokens and codes are SHA-256 hashed at rest. The
provider requires **encrypted**, not hashed, confidential-client secrets when
JWTs are disabled; encryption uses the configured Better Auth secret. Keep the
secret stable across restarts.

The service has one SQLite owner/process per data directory. Grant operations
and bearer checks are serialized to fence concurrent rotation/replay/revocation.
Bounded uploads and social-provider callbacks stay outside that critical section;
this is not a multi-worker/distributed deployment. The authoritative database is
`auth.sqlite` (mode 0600, WAL). Preserve the database and its live WAL consistently
when backing up; do not copy only the database file while it is being written.

DCR accepts at most five HTTPS or native loopback HTTP redirect URIs, rejects
credentials/fragments and remote JWKS metadata, limits bodies to 16 KiB and names
to 100 characters, and caps registrations at twenty attempts per minute per
service and one thousand persisted clients. Unconsented registrations expire
from the pool after an hour and the oldest unconsented registration can be evicted
at capacity; approved clients are never evicted. It deliberately does not accept
private-use URI schemes or arbitrary registration extension fields. Loopback
clients may omit `application_type`; the provider infers native registration.
Deploy a public ingress with appropriate connection/body-read timeouts and
network rate limiting as well. The service-level registration budget is global,
not a trust decision based on spoofable forwarded IP headers.

Browser writes require an exact same-origin Origin or Referer, even without
cookies. Only cookieless, originless/refererless OAuth token, registration,
revocation and introspection machine requests are exempt. Social callbacks are
GET requests protected by Better Auth's single-use OAuth state. UI scripts are
external and every response has no-store, no-referrer, nosniff and restrictive
CSP headers.

Authorization revocation removes the owner's consent, access/refresh family and
outstanding codes transactionally. Signout ends the browser session and its session-bound access tokens. An
`offline_access` refresh authorization survives and can issue new access tokens;
use revoke to disconnect a client. OAuth protocol redirects are validated registered client
callbacks; ordinary sign-in success/error redirects are fixed same-origin URLs.

## Verification

`bunx vitest run test/auth` exercises temporary SQLite stores and mocked vendor
network responses, including actual GitHub callback → login continuation →
consent → code redemption. Google admission tests sign real offline RSA ID tokens
and mock only Google's JWKS endpoint. No real credentials or vendor accounts are
used. Live-provider deployment acceptance still requires correctly configured
provider apps, HTTPS routing and environment configuration.
