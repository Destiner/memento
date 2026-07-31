// Field assembly shared by the V2 memory write paths: turning what an agent
// supplied into the canonical record the store persists.
//
// Two jobs live here rather than in memory-schema.ts, and for the same reason:
// both must run on the way *in* and must not run on the way *out*.
//
//   - Provenance defaults. `verification` is optional on input and always present
//     on disk, derived from `source` per memory-policy.md §9.
//   - Evidence durability. §9 admits durable references only — commit SHAs,
//     permanent URLs, issue ids, stable paths — and never transcripts, temp
//     files, or line numbers. That is checkable per kind, so it is checked, but a
//     failure drops the entry and is reported rather than failing the write.
//     Evidence is optional metadata; V2 exists to make agents reach for these
//     tools more often, and refusing a whole memory over one bad reference is a
//     good way to teach an agent not to bother.
//
// Keeping durability out of the record validator is what lets a person hand-write
// a sloppy reference into a memory file without making the memory unreadable.
// Only the write paths normalize; read-back checks shape alone.

import {
  MAX_EVIDENCE_ENTRIES,
  type CreateProvenanceInput,
  type DroppedEvidence,
  type EvidenceEntry,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryScope,
  type ProvenancePatch,
  type ProvenanceSource,
  type VerificationLevel,
} from './memory-schema.js';
// A generic first-seen-order dedupe that happens to live with the project
// identifiers it was written for; shared rather than copied so the two record
// types cannot drift on what "already present" means.
import { dedupeBy } from './project-normalize.js';

// §9: what each source implies about how well established the knowledge is,
// absent an explicit claim from the agent.
const VERIFICATION_DEFAULTS: Record<ProvenanceSource, VerificationLevel> = {
  user_stated: 'user_confirmed',
  agent_observed: 'observed_once',
  external_reference: 'source_confirmed',
  inferred: 'unverified',
};

const COMMIT_RE = /^[0-9a-f]{7,40}$/;
// `owner/repo#123`, the forge-agnostic short form for a pull request or issue.
const REPO_REF_RE = /^[\w.-]+\/[\w.-]+#\d+$/;
// `MEM-123`: Linear, Jira, and every tracker that copied them.
const TRACKER_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// Posix absolute, `~`-relative, UNC, and Windows drive paths alike.
const ABSOLUTE_PATH_RE = /^(?:[/~\\]|[A-Za-z]:[\\/])/;
// A trailing `:42`, `#L42`, or `#L42-L60` — the line references §9 forbids.
const LINE_REF_RE = /(?::\d+(?:-\d+)?|#L\d+(?:[-,]L?\d+)?)$/;
// Build output and dependency trees: present on one machine, meaningless on the
// next, and never the source of a durable claim.
const GENERATED_SEGMENT_RE =
  /(?:^|\/)(?:tmp|temp|node_modules|dist|build|out|coverage|\.next|\.cache|\.git)(?:\/|$)/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

type Normalized = { value: string } | { why: string };

export interface NormalizedEvidence {
  // Omitted when nothing survived, so the persisted YAML stays clean.
  evidence?: EvidenceEntry[];
  dropped: DroppedEvidence[];
}

export interface BuiltProvenance {
  provenance: MemoryProvenance;
  dropped: DroppedEvidence[];
}

/** The verification level a memory records: what the agent claimed, or the §9 default. */
export function resolveVerification(
  source: ProvenanceSource,
  supplied?: VerificationLevel,
): VerificationLevel {
  return supplied ?? VERIFICATION_DEFAULTS[source];
}

/** Dedupe key for an evidence entry: same kind, same reference, case-insensitive. */
export function evidenceKey(entry: EvidenceEntry): string {
  return `${entry.kind}:${entry.value.toLowerCase()}`;
}

/**
 * Canonicalize a list of evidence entries, dropping those that are not durable
 * references and reporting why.
 *
 * Order is first-seen: an agent lists the primary reference first, and a later
 * duplicate or an overflow past the cap is the one worth losing.
 */
export function normalizeEvidence(
  entries: readonly EvidenceEntry[] | undefined,
): NormalizedEvidence {
  const dropped: DroppedEvidence[] = [];
  if (entries === undefined) return { dropped };

  const kept: EvidenceEntry[] = [];
  for (const entry of entries) {
    const result = normalizeValue(entry.kind, entry.value.trim());
    if ('why' in result) {
      dropped.push({ kind: entry.kind, value: entry.value, why: result.why });
      continue;
    }
    kept.push(rebuild(entry, result.value));
  }

  const capped = cap(dedupeBy(kept, evidenceKey), dropped);
  return capped.length > 0 ? { evidence: capped, dropped } : { dropped };
}

/** Assemble the provenance a new memory persists (§9). */
export function buildProvenance(input: CreateProvenanceInput): BuiltProvenance {
  const { evidence, dropped } = normalizeEvidence(input.evidence);
  const provenance: MemoryProvenance = {
    source: input.source,
    verification: resolveVerification(input.source, input.verification),
  };
  if (evidence) provenance.evidence = evidence;
  return { provenance, dropped };
}

/**
 * Apply a provenance patch to an existing record's provenance.
 *
 * Two deliberate choices:
 *
 *   - A `source` change does not re-derive `verification`. Re-defaulting would
 *     silently downgrade a `user_confirmed` memory to `unverified` because the
 *     agent corrected where the knowledge came from, which is not what it asked
 *     for. An explicit `verification` in the patch is the only thing that moves it.
 *   - Existing evidence is carried through unexamined, never re-normalized. It may
 *     have been hand-written; an unrelated update is not the place to delete
 *     someone's reference. Only incoming entries are validated.
 */
export function mergeProvenance(
  existing: MemoryProvenance,
  patch: ProvenancePatch | undefined,
  replace = false,
): BuiltProvenance {
  const dropped: DroppedEvidence[] = [];
  const merged: MemoryProvenance = {
    source: patch?.source ?? existing.source,
    verification: patch?.verification ?? existing.verification,
  };

  if (patch?.evidence === undefined) {
    if (existing.evidence?.length) merged.evidence = existing.evidence.map(clone);
    return { provenance: merged, dropped };
  }

  const incoming = normalizeEvidence(patch.evidence);
  dropped.push(...incoming.dropped);

  const base = replace ? [] : (existing.evidence ?? []);
  const combined = cap(dedupeBy([...base, ...(incoming.evidence ?? [])], evidenceKey), dropped);
  if (combined.length > 0) merged.evidence = combined;

  return { provenance: merged, dropped };
}

/**
 * Apply a scope change.
 *
 * Project ids merge-append by default, matching `update_project`: the common call
 * is "this memory turns out to matter for that project too", and it must not drop
 * the ids the memory was already filed under. Switching to `global` discards them
 * — a global memory holding project ids is the contradiction the schema rejects.
 */
export function mergeScope(
  existing: MemoryScope,
  incoming: MemoryScope | undefined,
  replace = false,
): MemoryScope {
  if (incoming === undefined) {
    return existing.kind === 'projects'
      ? { kind: 'projects', project_ids: [...existing.project_ids] }
      : { kind: 'global' };
  }
  if (incoming.kind === 'global') return { kind: 'global' };

  const base = replace || existing.kind === 'global' ? [] : existing.project_ids;
  return {
    kind: 'projects',
    project_ids: dedupeBy([...base, ...incoming.project_ids], (id) => id),
  };
}

/**
 * Serialize a record's fields in canonical order, omitting empty optionals.
 *
 * V2 rebuilds this order rather than preserving whatever order it found on disk,
 * which reverses the V1 memory behaviour and matches `orderProjectMetadata`. The
 * V1 reasoning was that a memory carried a dozen optional metadata fields a person
 * may have arranged deliberately; V2 has eleven structured fields and no free-form
 * ones, so a predictable layout is worth more than a preserved shuffle. The prose
 * a person actually arranged is the body, which is never reordered.
 */
export function orderMemoryMetadata(record: MemoryRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    id: record.id,
    title: record.title,
    description: record.description,
    scope: orderScope(record.scope),
    type: record.type,
    provenance: orderProvenance(record.provenance),
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.last_verified_at) metadata.last_verified_at = record.last_verified_at;
  if (record.archive_reason) metadata.archive_reason = record.archive_reason;
  return metadata;
}

function orderScope(scope: MemoryScope): Record<string, unknown> {
  return scope.kind === 'projects'
    ? { kind: scope.kind, project_ids: [...scope.project_ids] }
    : { kind: scope.kind };
}

function orderProvenance(provenance: MemoryProvenance): Record<string, unknown> {
  const ordered: Record<string, unknown> = {
    source: provenance.source,
    verification: provenance.verification,
  };
  if (provenance.evidence?.length) {
    ordered.evidence = provenance.evidence.map((entry) => {
      const value: Record<string, unknown> = { kind: entry.kind, value: entry.value };
      if (entry.note) value.note = entry.note;
      return value;
    });
  }
  return ordered;
}

// Keep the first MAX_EVIDENCE_ENTRIES and report the rest. The schema caps a
// single call's array, but merging an update into an existing record can overflow
// without either side having violated the shape.
function cap(entries: EvidenceEntry[], dropped: DroppedEvidence[]): EvidenceEntry[] {
  for (const overflow of entries.slice(MAX_EVIDENCE_ENTRIES)) {
    dropped.push({
      kind: overflow.kind,
      value: overflow.value,
      why: `evidence is capped at ${MAX_EVIDENCE_ENTRIES} entries`,
    });
  }
  return entries.slice(0, MAX_EVIDENCE_ENTRIES);
}

function normalizeValue(kind: EvidenceEntry['kind'], value: string): Normalized {
  switch (kind) {
    case 'commit':
      return normalizeCommit(value);
    case 'pull_request':
      return normalizeForgeRef(value, 'pull request', [REPO_REF_RE]);
    case 'issue':
      return normalizeIssue(value);
    case 'url':
      return normalizeUrl(value);
    case 'path':
      return normalizePath(value);
  }
}

// A sha, not a branch, tag, `HEAD`, or `a..b` range: those move, and a moving
// reference is not evidence.
function normalizeCommit(value: string): Normalized {
  const sha = value.toLowerCase();
  if (!COMMIT_RE.test(sha)) {
    return { why: 'not a commit sha (expected 7-40 hexadecimal characters)' };
  }
  return { value: sha };
}

function normalizeIssue(value: string): Normalized {
  if (TRACKER_KEY_RE.test(value)) return { value: value.toUpperCase() };
  return normalizeForgeRef(value, 'issue', [REPO_REF_RE, TRACKER_KEY_RE]);
}

// Either a short forge reference or a permanent URL. A value carrying a scheme is
// judged as a URL, so its own reason (a `file:` scheme, a local host) surfaces
// instead of a generic shape complaint.
function normalizeForgeRef(value: string, label: string, patterns: RegExp[]): Normalized {
  if (patterns.some((pattern) => pattern.test(value))) return { value };
  if (SCHEME_RE.test(value)) return normalizeUrl(value);
  return {
    why: `not a durable ${label} reference (expected owner/repo#123, a tracker key, or a permanent URL)`,
  };
}

function normalizeUrl(value: string): Normalized {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { why: 'not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { why: `${url.protocol.replace(':', '')} URLs are not durable references` };
  }
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local')) {
    return { why: `${host} is a local address, so the reference will not resolve later` };
  }
  // Fragments survive: a forge permalink pinned to a sha with `#L12-L30` is a
  // durable reference, which is a different thing from the bare `path:42` that
  // §9 rules out.
  return { value: url.toString() };
}

function normalizePath(value: string): Normalized {
  if (ABSOLUTE_PATH_RE.test(value)) {
    return { why: 'an absolute path is machine-specific; use a repository-relative path' };
  }
  if (LINE_REF_RE.test(value)) {
    return { why: 'line numbers are not durable (§9); reference the file itself' };
  }

  const cleaned = value
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (cleaned === '') return { why: 'not a path' };
  if (cleaned.split('/').includes('..')) {
    return { why: 'a path containing ".." does not identify a stable location' };
  }
  if (GENERATED_SEGMENT_RE.test(cleaned)) {
    return { why: 'points into generated or temporary output rather than source' };
  }
  return { value: cleaned };
}

function rebuild(entry: EvidenceEntry, value: string): EvidenceEntry {
  return entry.note === undefined
    ? { kind: entry.kind, value }
    : { kind: entry.kind, value, note: entry.note };
}

function clone(entry: EvidenceEntry): EvidenceEntry {
  return rebuild(entry, entry.value);
}
