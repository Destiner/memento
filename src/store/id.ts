// Stable identifiers and deterministic filenames for memory files.
//
// IDs are ULIDs (§7: "ULID or UUIDv7-style sortable identifiers") prefixed with
// `mem_`. A ULID is a 48-bit millisecond timestamp followed by 80 bits of
// randomness, Crockford-base32 encoded — lexicographically sortable by creation
// time, which the search index leans on for a cheap recency tie-break. Rolled by
// hand to avoid a dependency; the format is small and well specified.

import { randomBytes } from 'node:crypto';

// Crockford's base32 alphabet: no I, L, O, or U (to avoid ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

const ID_PREFIX = 'mem_';
const PROJECT_ID_PREFIX = 'prj_';
const QUERY_ID_PREFIX = 'qry_';
const EVENT_ID_PREFIX = 'evt_';
const DEFAULT_SLUG_MAX = 60;

// Encode a millisecond timestamp as the 10-char ULID time component.
function encodeTime(now: number): string {
  let value = now;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

// 16 chars of randomness (80 bits). 256 is divisible by 32, so `byte % 32` is
// an unbiased index into the alphabet.
function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_CHARS);
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

// Generate a fresh, sortable memory id (`mem_` + 26-char ULID). `now` is
// injectable so tests can assert on the deterministic timestamp prefix.
export function generateId(now: number = Date.now()): string {
  return ID_PREFIX + encodeTime(now) + encodeRandom();
}

// A `prj_`-prefixed ULID for a project registry record (V2 §2). Opaque and
// immutable: a project's name, paths, and remotes all change over its life, and
// this is the one field that does not.
export function generateProjectId(now: number = Date.now()): string {
  return PROJECT_ID_PREFIX + encodeTime(now) + encodeRandom();
}

// A `qry_`-prefixed ULID for correlating a search call with its log event
// (§9.3). Same format as a memory id, different namespace so the two never mix.
export function generateQueryId(now: number = Date.now()): string {
  return QUERY_ID_PREFIX + encodeTime(now) + encodeRandom();
}

// An `evt_`-prefixed ULID for a single instrumentation event (§13). Sortable by
// creation time, distinct namespace from memory and query ids.
export function generateEventId(now: number = Date.now()): string {
  return EVENT_ID_PREFIX + encodeTime(now) + encodeRandom();
}

// Derive a deterministic, filesystem-safe slug from a title. Lowercased,
// non-alphanumeric runs collapsed to single hyphens, trimmed, length-capped.
export function slugify(title: string, maxLength = DEFAULT_SLUG_MAX): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const capped = slug.slice(0, maxLength).replace(/-+$/g, '');
  return capped || 'memory';
}

// Canonical filename for a memory: `<id>-<title-slug>.md`. The id keeps it
// unique; the slug keeps the directory human-scannable.
export function memoryFilename(id: string, title: string): string {
  return `${id}-${slugify(title)}.md`;
}

// Canonical filename for a project registry record: `<id>-<name-slug>.md`.
export function projectFilename(id: string, name: string): string {
  return `${id}-${slugify(name)}.md`;
}
