# Account store (Cloudflare)

One SQLite Durable Object owns one account. Call `withAccountStore(storage, fn)` from the account object's serialized request handler and await it before returning the response. Do not overlap calls using the same storage, including imports. The callback must await its work (and must not retain the context or scratch paths). Use `nodejs_compat` with `node:fs` enabled.

## Importer interface

`cloudflare/account-store.ts` exports `AccountDocument` (`{ path: string; contents: string }`), `replaceEmptyAccountDocuments(storage, documents)`, and `readAccountDocuments(storage)`. These are internal primitives, not request handlers. Pass `config.json`, `memories/<original filename>.md`, or `projects/<original filename>.md` only. The importer is responsible for trusted destination selection and validating frontmatter, duplicate IDs and references before calling the helper. Reject symlinks and unsupported source entries before reading source files. Use `ACCOUNT_DOCUMENT_LIMITS` to bound the source scan before loading contents. The helper enforces path and size limits (plain filenames up to 255 UTF-8 bytes, with no traversal, backslashes or control characters) and atomically refuses to overwrite any account store that has already been opened (even if it is empty). No index, logs, OAuth data or other sidecars belong in the imported documents.

`readAccountDocuments` returns only the authoritative documents scoped to the supplied storage. The FTS index is derived; tools use the native SQLite index and rebuild it from Markdown after an interrupted session. The actual store never resides in `/tmp`; tool `path` fields refer only to the request's temporary working copy, not a path clients can open after the call.

## Limits and logs

The account adapter is for small stores: at most 1,024 documents, each up to 256 KiB, with 8 MiB total UTF-8 document content. Canonical documents are hydrated in a fresh, private scratch directory for each request; only changed and deleted documents are written back. Cloudflare documents `/tmp` as request-local. The adapter does not depend on files surviving between requests: it explicitly removes the working copy, and records its identifier to clean up after interruption if the runtime retains it (as observed in local workerd). A request over the write limit does not commit partial document changes.

Tool events retain the existing JSON event shape, in a separate SQLite table in the account object (not in global logs). At most 256 events of up to 8 KiB each are retained, oldest first to be evicted; at most 32 events are collected from a single request. Oversize events and events from aborted store sessions are dropped. No historical Node JSONL logs are imported.
