# Render → Cloudflare migration

This is an owner-approved, one-way cutover, not a backup or sync system. Keep the
canonical HTTPS origin (including its exact spelling), Better Auth secret, admission
rules and provider configuration unchanged. The source and destination must **never
both serve application traffic**. No upload, admin, status, or import HTTP endpoint
is involved.

## 1. Rehearse and approve the destination

From the repo root on Node 22.16+ with the project dependencies installed:

```sh
node_modules/.bin/tsc -p cloudflare/operator/tsconfig.json
node_modules/.bin/vitest run --config cloudflare/operator/vitest.config.ts
```

The synthetic rehearsal uses the sealing CLI, local workerd/Miniflare, its local
scheduled-event dispatcher, local R2, and the main Worker's SQLite Durable Objects. It exercises the
same scheduled handler as production: successful import, concurrent and repeat
delivery, non-matching time/cron, expired invocation, missing exact key, wrong hash,
key or origin, invalid snapshot membership/documents/auth constraints, an ambiguous
claim without receipt, and partial DO failure. It also tests 128 accounts and a
large account/auth payload through real local RPC and SQLite. It does not use real
identities, provider credentials or Cloudflare resources. Follow the
[deployment acceptance checklist](deployment.md#acceptance-checklist) separately;
local simulation does not establish production OAuth, routing, or billing behavior.

Review and record the exact Cloudflare account, target script, fresh SQLite namespaces,
private bucket, approved origin, and cutover window. The target main Worker must be
provisioned **dark**: `workers_dev = false`, `preview_urls = false`, no custom domain,
no routes or other callers (including stale deployments and service bindings), and
maintenance mode if supported. Do not attach an existing populated namespace. Do not
call normal target auth or MCP while dark. The operator has cross-script bindings to
the main Worker's `AuthObject` and `AccountObject` classes, **not** its `fetch` handler.
The target config's own origin is checked by the auth import against the snapshot's
exact canonical MCP resource before any account writes. A snapshot for
`https://memento.destiner.io` may also retain the historical Render MCP resource
and its grants unchanged. This does not make Render-audience bearers valid at the
canonical endpoint. The exporter includes one entry per
auth `user.id`, including empty stores; duplicates, omissions and orphan stores fail
validation. Refer to [the snapshot contract](../cloudflare/snapshot.md).

Create an isolated, standard-class R2 bucket. Confirm the bucket's public development
URL and custom domains are off, and don't create presigned links. Reserve a fresh
random key prefix for this run; do not reuse it or configure lifecycle expiration
until the operator and its trigger are gone. Limit staging writes/reads to authorized
operators. In particular, R2 write authority can forge/erase receipts and claims;
those keys are not an attestation against a compromised Cloudflare administrator.

## 2. Freeze Render and export without losing disk access

1. Review the freeze/rollback plan and credentials-transfer method with the owner.
   Record the current service revision, known-good start command, env configuration
   locations (not values), custom domain/DNS configuration and OAuth callbacks. Pause
   clients, automatic deploys, Blueprint autosync, jobs and every other writer.
2. Keep the **same disk-backed service** running with a temporary maintenance start
   command, not a suspended service, one-off job, build, or predeploy. Prepare this
   change in advance and keep the health check path `/health`. For example, use this
   start command in the existing service's Render settings:

   ```sh
   node --input-type=module -e 'import {createServer} from "node:http"; createServer((req,res)=>{const ok=(req.method==="GET"||req.method==="HEAD")&&req.url==="/health";res.writeHead(ok?200:503,{"Cache-Control":"no-store"});res.end();}).listen(Number(process.env.PORT),"0.0.0.0");'
   ```

   This responds to existing health checks and keeps the disk mounted without opening
   Memento data. The old shell may disconnect on rollout: reconnect to the new
   instance via authorized Render SSH/Shell. Wait for the maintenance deployment to
   replace the old process; verify the disk mount in that shell, the old Node server
   is gone, and MCP/auth on **all** previous ingress paths return maintenance errors.
   Check direct `onrender.com` ingress as well as the custom domain. Do not proceed on
   a failed deployment, stale writer/lock, or uncertain shutdown. Never force-remove
   a lock or delete a SQLite sidecar to make an export pass.
3. Once cleanly stopped/checkpointed, make a private frozen copy on the mounted disk
   (plan free space; preserve ownership/permissions). Confirm exporter Node/tooling and
   repo revision are present on that instance before freezing; if needed securely
   transfer the reviewed exporter/tooling ahead of time. Use absolute paths and
   `umask 077`. Follow [offline export](../cloudflare/snapshot.md), with
   `MEMENTO_DATA_DIR` pointing to the frozen copy and `MEMENTO_SNAPSHOT_FILE` to a new
   private file outside it. Export on the disk-backed runtime. Do not copy a live DB
   or move the backup via a web route, console paste, shared log or artifact store.
4. Prefer sealing on the same trusted host and transferring **only ciphertext** and
   approval metadata to the provisioning host. If moving plaintext or the key across
   hosts is necessary, use separately approved encrypted/authenticated channels and
   private storage. Keep raw backups/secrets out of argv, source, build/artifacts, shell
   substitution, logs and chat. Disable shell tracing and core dumps; use a private
   encrypted workspace and no cloud-synced folders. Do not attach either data or
   secrets to the Worker bundle. Transfer auth/provider secrets through approved
   secret storage; do not extract or emit them in the snapshot tooling.

## 3. Seal, approve, stage and provision once

Example commands are for **authorized operators only**, not a deployment script.
Run from the repo root. `$PRIVATE` is a secure mode-0700 directory outside the
checkout; `$SOURCE` is the mode-0600 plaintext export (a path only).

```sh
umask 077
set +x
ORIGIN='https://your-canonical-domain.example'
RUN_ID=$(openssl rand -hex 16)  # non-secret; record it with the approval
STAGING_KEY="migration/$RUN_ID/snapshot.aead"
node --import tsx cloudflare/operator/seal.ts "$ORIGIN" "$STAGING_KEY" \
  "$SOURCE" "$PRIVATE/snapshot.aead" "$PRIVATE/migration.key" > "$PRIVATE/approval.json"
```

`seal.ts` enforces the shared schema/capacity, uses a fresh random 256-bit key and
96-bit nonce with AES-256-GCM, and never prints the key or contents. The authenticated
context includes the exact staging key and canonical origin. Review `approval.json`
(ciphertext SHA-256 plus expected counts) locally and independently confirm the
hash of the exact encrypted artifact, e.g. `shasum -a 256 "$PRIVATE/snapshot.aead"`.
Allow at least `accountsVerified + 7` internal subrequests for the approved run.
The documented Workers Paid default is above this bound; check for overrides.
The success path uses `accountsVerified + 6` calls: two R2 heads, one R2 get,
one claim put, one auth RPC, one RPC per account and one receipt put. If the
success receipt write fails, a best-effort failure receipt may add one call
(135 total at 128 accounts). All calls are serial. Confirm CPU, wall time,
per-isolate memory and storage limits separately; the operator cannot verify
live quotas before claiming. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
and [snapshot capacity](../cloudflare/snapshot.md). Bind
that approved digest before arming the Worker; **do not** derive approval from the
object that happens to be in R2. Use the same locally recorded key path and SHA-256
when staging and verifying. A seal failure can leave incomplete output files; do not
use them or overwrite them, and always generate a new key/run when re-sealing.

In a private config copied from `cloudflare/operator/wrangler.toml`, use an absolute
`main` path to the reviewed operator `worker.ts`. Choose a fresh Worker name if
needed; do not overwrite an existing script or arm a second operator. Fill in `STAGING_KEY`,
`EXPECTED_SHA256`, `EXPECTED_ORIGIN`, actual private `bucket_name`, and the exact main
Worker `script_name` for both bindings. Do not copy secrets into config. Verify the
active account and names before any Cloudflare command, and don't use tokens passed
as flags or hardcoded environment assignments.

Pick **one approved future UTC minute** with at least 15 minutes for Cron Trigger
propagation plus operational margin (or longer per Cloudflare docs). Put its ISO
value, with seconds and milliseconds zero, in `SCHEDULED_AT`. For example, for
`2027-01-17T04:23:00.000Z` set `crons = ["23 4 17 1 *"]`. Cron itself has no year;
this Worker checks the exact year/timestamp, exact cron expression and a ten-minute
admission window, and does not call a DO on any other event. Use exactly the generated
numeric spelling (no leading zeroes); do not enable interval polling. Stage before
arming. In production only, using your authorized account and private config:

```sh
# BUCKET is the registered private bucket; CFG is the private config path.
node_modules/.bin/wrangler r2 object put "$BUCKET/$STAGING_KEY" \
  --remote --file "$PRIVATE/snapshot.aead" --config "$CFG"
# Create an exclusive private dotenv file without putting secret material in argv.
( set -C; { printf 'MIGRATION_KEY='; cat "$PRIVATE/migration.key"; printf '\n'; } \
  > "$PRIVATE/operator-secrets.env" )
# Ensure MIGRATION_KEY is absent from the shell environment: file values must win.
unset MIGRATION_KEY
node_modules/.bin/wrangler deploy --config "$CFG" --secrets-file "$PRIVATE/operator-secrets.env"
```

Do not tail logs or enable observability/debug output on private payload imports.
Verify the deployed bindings, effective trigger, and absence of all ingress in
Cloudflare control-plane settings, without HTTP probing for migration endpoints.
If provisioning misses the selected minute, stop instead of using an HTTP test
trigger or widening the window. There is no production manual trigger.

## 4. Verify, then release

At the approved time the Worker checks the staged object's byte size and validates
its exact hash **before** AEAD open. Before claiming it validates the raw plaintext
size, UTF-8 JSON, envelope, snapshot capacity, account membership and auth constraints.
An R2 create-only `claim.json` fences concurrent or replayed invocations. It is
written before any DO call. Auth imports first and verifies persisted rows and target
origin; then account DOs import serially, each verifying its own persisted paths and
contents. No write spans multiple DOs atomically. Only a complete success writes a
create-only `receipt.json` with `status: "verified"` and independent DO acknowledgments.
Read the claim and receipt via authenticated R2 access, not the public Internet:

```sh
for name in claim receipt; do
  node_modules/.bin/wrangler r2 object get "$BUCKET/migration/$RUN_ID/$name.json" \
    --remote --file "$PRIVATE/$name.json" --config "$CFG" || break
done
```

Use fresh download paths. Set `SCHEDULED_AT` from the recorded approval (not from
R2). Require both downloads and an exit status of zero from this local `jq` check:

```sh
jq -e -n --arg scheduled "$SCHEDULED_AT" \
  --slurpfile approved "$PRIVATE/approval.json" \
  --slurpfile claim "$PRIVATE/claim.json" --slurpfile receipt "$PRIVATE/receipt.json" '
    (($approved|length) == 1 and ($claim|length) == 1 and ($receipt|length) == 1) and
    ($approved[0] as $a | $receipt[0] as $r |
      ($a.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      all($a.accountsVerified, $a.documentsVerified; type == "number" and . >= 0 and floor == .) and
      all($claim[0], $r; .version == 1 and .sha256 == $a.sha256 and .scheduledAt == $scheduled) and
      $r.status == "verified" and $r.authVerified == true and
      $r.accountsVerified == $a.accountsVerified and $r.documentsVerified == $a.documentsVerified)
  '
```

A missing, failed, mismatched or unexpected receipt means **do not release**.
Counts in a failed receipt are acknowledgements, not proof that the next call did
not commit.

After successful verification, remove the Cron Trigger from the operator in
Workers & Pages, then delete that operator script (not the main Worker). Do this
before attaching the canonical domain/releasing main ingress. Confirm the cleanup and that
Render is still frozen; configure routing/TLS and then perform the normal owner
smoke tests (health, unauthenticated MCP challenge, OAuth handshake/reconnect,
representative read/search, isolation, then authorized writes/revocation). Use actual
authorized accounts only and record results without private bodies, tokens or IDs.
Indexes rebuild from imported documents on first use; logs/indexes are not migrated.
Keep client writers paused until these checks pass. Do not use a public migration
route or substitute a `workers.dev` URL as the OAuth issuer.

## 5. Failure, rollback and cleanup

- **No claim:** wait for the event/runtime to finish and disarm the old trigger;
  after confirming no claim/receipt exists in the correct private bucket, diagnose
  using deployment/schedule state and locally recomputed digest, key and validation.
  Failed delivery before a claim cannot have called a DO. Rehearse the correction;
  require fresh approval, staging prefix, key and future minute. Do not auto-retry.
- **Claim without a matching verified receipt:** treat the target as contaminated,
  even if the receipt says zero verified. Keep it dark, disable the trigger, preserve
  evidence privately and have the owner decide whether to abandon/retain it. Use a
  new independently confirmed pristine target for any approved rerun. Do not delete
  the claim to force a retry, resume by account, reset namespace bindings by guess,
  or attempt merge/overwrite. Partial writes cannot be rolled back across DOs.
- **Return to Render before any destination traffic:** disarm/delete the operator,
  ensure main target remains dark and no concurrent invocation can release it; restore
  original Render start command/config, DNS if changed, and validate service health
  and clients before resuming reliance on it. Preserve the source disk and start
  settings. **After target auth or application writes**, Render is stale (including
  rotated tokens, consent/revocation and access timestamps). Moving DNS back is not a
  data rollback. Keep both sides gated until the owner approves reconciliation,
  restoration with explicit data loss, or forward repair. There is no reverse sync.
- **Cleanup:** confirm no trigger, routes, preview/workers.dev URLs, operator or
  retained operator secrets remain. Remove staging ciphertext, claim and receipt
  only once the Worker can no longer run and evidence is recorded under the retention
  policy. Delete the dedicated bucket if unused; revoke any temporary credentials.
  Dispose of local plaintext, private key copies and temporary Render exports per
  retention policy (on SSD/cloud storage, deletion is not proof of erasure; use
  encrypted storage/key disposal). Remove maintenance mode and retire the Render
  service/disk only after a separately approved rollback/retention window. Verify no
  abandoned target resources remain and keep an auditable non-sensitive disposition.

Budget for concurrent Render service/disk plus destination Workers and SQLite Durable
Objects, private R2 standard storage and Class A/B operations, and retained copies or
abandoned destinations. One run adds one scheduled invocation (subject to delivery),
a few R2 reads/writes, one auth RPC plus one per user and SQLite writes/readback
proportional to the data. No ongoing polling fee is intended, but a forgotten Cron,
R2 bucket, Render disk or abandoned DO namespace can continue to incur charges. Check
current [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/) and Render plan limits/rates before
approval; do not assume free tier or estimate from compressed backup size.
