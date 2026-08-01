// Canonicalization for the project identifiers agents supply as evidence.
//
// Identifiers arrive in whatever form the agent happened to see: an scp-style
// git remote, an https clone URL with credentials embedded, a `~`-relative
// checkout path. Normalizing on write means every stored identifier is already
// canonical, so resolution is plain equality rather than a similarity contest.
//
// Every function here is idempotent: normalize(normalize(x)) === normalize(x).
// That is what lets an already-canonical value round-trip through create and
// update without drifting.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { MementoError } from '../errors.js';

// Cap on retained checkout records. A moved checkout appends rather than
// replaces (a second entry may be a worktree or another machine), so the array
// needs a bound; the least-recently-seen entry is evicted past this.
export const MAX_WORKING_DIRECTORIES = 20;

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
// scp-style: `[user@]host:path`, where host holds no slash (that would make it
// a bare path) and the path is non-empty.
const SCP_RE = /^(?:[^/@]+@)?([^/:]+):(.+)$/;
// A leading `NNN/` on an scp-style path is a port the caller meant as
// `ssh://host:NNN/path` — the only case where the text after `:` is not a path.
const LEADING_PORT_RE = /^(\d+)\//;
const HOST_PORT_RE = /^(.*?):(\d+)$/;

/**
 * Canonicalize a git remote to `host/path`, lowercased, with no scheme, no
 * credentials, no port, and no `.git` suffix.
 *
 * Dropping userinfo is the point, not a side effect: a raw `https://` remote
 * can carry a token, and docs/memory-policy.md §3 forbids the store holding secrets.
 */
export function normalizeGitRemote(input: string): string {
  const raw = input.trim();
  if (raw === '') {
    throw new MementoError('validation_error', 'Git remote must not be empty.');
  }

  const { host, path } = splitRemote(raw);
  const cleanedHost = stripPort(stripUserinfo(host)).toLowerCase();
  const cleanedPath = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();

  if (cleanedHost === '' || cleanedPath === '') {
    throw new MementoError(
      'validation_error',
      `Git remote ${JSON.stringify(input)} has no host and path to canonicalize.`,
      { remote: input },
    );
  }
  return `${cleanedHost}/${cleanedPath}`;
}

/**
 * Derive the `owner/repo` slug implied by a canonical remote, or undefined when
 * the path has only one segment.
 *
 * The last two segments win, which is right for GitHub-shaped forges and wrong
 * for deeply nested GitLab groups (`group/sub/project` yields `sub/project`).
 * That is a deliberate default: slugs are a soft matching signal (S1), so an
 * imprecise one costs a disambiguation round-trip, not a wrong answer. An agent
 * that wants the full path can supply it explicitly.
 */
export function deriveRepositorySlug(canonicalRemote: string): string | undefined {
  const segments = canonicalRemote.split('/').slice(1);
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join('/');
}

/** Canonicalize a repository slug: lowercased, no `.git`, at least two segments. */
export function normalizeRepositorySlug(input: string): string {
  const slug = input
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  const segments = slug.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) {
    throw new MementoError(
      'validation_error',
      `Repository slug ${JSON.stringify(input)} must look like "owner/repo".`,
      { slug: input },
    );
  }
  return segments.join('/');
}

/**
 * Canonicalize a working-directory path: `~` expanded, absolute, `.`/`..`
 * collapsed, symlinks resolved when the path exists, no trailing slash.
 *
 * Symlink resolution matters because an agent's cwd and a stored checkout path
 * can be two spellings of one directory (`/tmp/x` vs `/private/tmp/x` on macOS).
 * Both sides of a comparison run through here, so they agree. A path that does
 * not exist is kept as resolved rather than rejected — registering a checkout
 * that is currently unmounted or on another machine is legitimate.
 */
export async function normalizeWorkingDirectory(input: string): Promise<string> {
  const expanded = expandHome(input.trim());
  if (expanded === '') {
    throw new MementoError('validation_error', 'Working directory must not be empty.');
  }
  if (!isAbsolute(expanded)) {
    throw new MementoError(
      'validation_error',
      `Working directory ${JSON.stringify(input)} must be an absolute path.`,
      { path: input },
    );
  }

  const resolved = resolve(expanded);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Comparison key for a working-directory path. Case-insensitive on every
 * platform: macOS and Windows demand it, and the false-collision risk on a
 * case-sensitive filesystem (two checkouts differing only by case) is not worth
 * a platform-dependent code path.
 */
export function workingDirectoryKey(path: string): string {
  return path.toLowerCase();
}

/**
 * Comparison key for a project name or alias. Same transformation as `slugify`
 * but a distinct function on purpose: `slugify` builds filenames, so it caps
 * length and falls back to a placeholder for an empty result. A comparison key
 * must do neither — truncating would merge two long names, and a placeholder
 * would merge every unnameable one.
 */
export function nameKey(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deduplicate while preserving first-seen order, keyed by an arbitrary projection. */
export function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function splitRemote(raw: string): { host: string; path: string } {
  if (SCHEME_RE.test(raw)) {
    const rest = raw.replace(SCHEME_RE, '');
    const slash = rest.indexOf('/');
    if (slash === -1) {
      throw new MementoError(
        'validation_error',
        `Git remote ${JSON.stringify(raw)} has no repository path.`,
        { remote: raw },
      );
    }
    return { host: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  const scp = SCP_RE.exec(raw);
  if (scp) {
    const host = scp[1]!;
    let path = scp[2]!;
    const port = LEADING_PORT_RE.exec(path);
    if (port) path = path.slice(port[0].length);
    return { host, path };
  }

  // Bare `host/path`, which is also the canonical form this module emits — so an
  // already-normalized remote passes back through unchanged. A host must look
  // like one; a local filesystem path is a working directory, not a remote.
  const slash = raw.indexOf('/');
  const host = slash === -1 ? raw : raw.slice(0, slash);
  if (slash !== -1 && (host.includes('.') || host === 'localhost')) {
    return { host, path: raw.slice(slash + 1) };
  }
  throw new MementoError(
    'validation_error',
    `Git remote ${JSON.stringify(raw)} is not a recognizable remote URL. ` +
      'Expected a scp-style, ssh://, https://, or host/path remote; a local ' +
      'filesystem path belongs in working_directories.',
    { remote: raw },
  );
}

function stripUserinfo(host: string): string {
  const at = host.lastIndexOf('@');
  return at === -1 ? host : host.slice(at + 1);
}

function stripPort(host: string): string {
  const match = HOST_PORT_RE.exec(host);
  return match ? match[1]! : host;
}

// Local to the store layer: config.ts has its own tilde expansion for the memory
// home, but the store deliberately takes directories as arguments rather than
// importing configuration.
function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}
