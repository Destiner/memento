// The resolve_project operation (V2 §2, §5): map whatever evidence an agent has
// — a working directory, a git remote, a repository slug, a name — onto a
// registered project.
//
// Read-only and idempotent: nothing here writes, not even `last_seen_at`. That
// is a deliberate contract choice, and it has a consequence worth knowing —
// `last_seen_at` records when an agent last *reported* a checkout, not when it
// was last used, so it is sound for evicting the least-recently-seen path and
// unsound as an activity metric.
//
// Evidence is tiered by how strongly it identifies a project, and the first tier
// that matches anything wins. The tiers below repository-slug never return
// `exact_match`, because those signals are shared by construction: a monorepo
// hosts several projects behind one remote (S1), so several candidates for one
// remote is a correct answer, not a corrupt registry.

import { validate } from '../validation.js';
import {
  nameKey,
  normalizeGitRemote,
  normalizeRepositorySlug,
  workingDirectoryKey,
} from './project-normalize.js';
import {
  loadProjectRegistry,
  normalizeOptionalDirectory,
  projectDirectoryKeys,
  projectNameKeys,
  type ProjectEntry,
} from './project-registry.js';
import {
  resolveProjectInputSchema,
  toProjectSummary,
  type ProjectSummary,
  type ResolveProjectInput,
} from './project-schema.js';

export type MatchSignal =
  | 'working_directory'
  | 'working_directory_prefix'
  | 'git_remote'
  | 'repository_slug'
  | 'name'
  | 'name_fuzzy';

/**
 * A change the caller's evidence implies but the record does not yet hold —
 * a checkout at a new path, or a remote the project has just acquired.
 *
 * Resolution reports these; only `update_project` applies them. This is what
 * keeps P1 and P2 reachable: an agent that resolved by name learns that the
 * directory it is standing in is unregistered, without resolution having to
 * write behind its back.
 */
export interface ProjectSuggestion {
  field: 'working_directories' | 'git_remotes' | 'repository_slugs';
  value: string;
}

export type ResolveProjectResult =
  | {
      outcome: 'exact_match';
      matched_on: MatchSignal;
      project: ProjectSummary;
      suggestions: ProjectSuggestion[];
    }
  | { outcome: 'candidates'; matched_on: MatchSignal; candidates: ProjectSummary[] }
  | { outcome: 'not_found' };

export interface ResolveProjectOptions {
  projectsDir: string;
}

interface Evidence {
  directoryKey?: string;
  directoryPath?: string;
  remote?: string;
  slug?: string;
  nameHintKey?: string;
}

// Signals strong enough to name a single project when exactly one matches.
const DECISIVE: ReadonlySet<MatchSignal> = new Set<MatchSignal>([
  'working_directory',
  'working_directory_prefix',
  'git_remote',
  'name',
]);

export async function resolveProject(
  rawInput: unknown,
  options: ResolveProjectOptions,
): Promise<ResolveProjectResult> {
  const input = validate(resolveProjectInputSchema, rawInput);
  const evidence = await normalizeEvidence(input);

  const registry = await loadProjectRegistry(options.projectsDir);
  const pool = input.include_archived ? registry.all : registry.active;

  for (const [signal, matches] of tiers(pool, evidence)) {
    if (matches.length === 0) continue;
    if (matches.length === 1 && DECISIVE.has(signal)) {
      const entry = matches[0]!;
      return {
        outcome: 'exact_match',
        matched_on: signal,
        project: toProjectSummary(entry.record),
        suggestions: suggestionsFor(entry, evidence),
      };
    }
    return { outcome: 'candidates', matched_on: signal, candidates: summarize(matches) };
  }

  return { outcome: 'not_found' };
}

// Tiers in precedence order, evaluated lazily by the caller's early return.
function* tiers(
  pool: readonly ProjectEntry[],
  evidence: Evidence,
): Generator<[MatchSignal, ProjectEntry[]]> {
  const { directoryKey, remote, slug, nameHintKey } = evidence;

  if (directoryKey !== undefined) {
    yield [
      'working_directory',
      pool.filter((entry) => projectDirectoryKeys(entry.record).includes(directoryKey)),
    ];
    yield ['working_directory_prefix', longestPrefixMatches(pool, directoryKey)];
  }

  if (remote !== undefined) {
    yield [
      'git_remote',
      pool.filter((entry) => (entry.record.identifiers?.git_remotes ?? []).includes(remote)),
    ];
  }

  if (slug !== undefined) {
    yield [
      'repository_slug',
      pool.filter((entry) => (entry.record.identifiers?.repository_slugs ?? []).includes(slug)),
    ];
  }

  if (nameHintKey) {
    yield ['name', pool.filter((entry) => projectNameKeys(entry.record).includes(nameHintKey))];
    yield [
      'name_fuzzy',
      pool.filter((entry) => fuzzyNameMatch(projectNameKeys(entry.record), nameHintKey)),
    ];
  }
}

/**
 * Projects whose registered checkout contains the caller's directory, keeping
 * only those matching at the deepest level.
 *
 * The depth rule is what makes a monorepo sub-project resolvable: with `/repo`
 * and `/repo/packages/api` both registered, a caller inside the latter gets the
 * sub-project, not its parent.
 */
function longestPrefixMatches(pool: readonly ProjectEntry[], directoryKey: string): ProjectEntry[] {
  let best = 0;
  const depths = new Map<ProjectEntry, number>();

  for (const entry of pool) {
    for (const candidate of projectDirectoryKeys(entry.record)) {
      if (candidate === directoryKey || !isPathPrefix(candidate, directoryKey)) continue;
      const depth = candidate.length;
      if (depth > (depths.get(entry) ?? 0)) depths.set(entry, depth);
      if (depth > best) best = depth;
    }
  }

  return pool.filter((entry) => depths.get(entry) === best && best > 0);
}

function isPathPrefix(parent: string, child: string): boolean {
  const boundary = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(boundary);
}

// A hint matches loosely when one name is a prefix of the other or they share a
// word. Deliberately generous: this tier only ever produces candidates, so a
// false positive costs the agent a line of output, while a false negative costs
// it a duplicate project.
function fuzzyNameMatch(keys: readonly string[], hintKey: string): boolean {
  const hintTokens = new Set(hintKey.split('-').filter(Boolean));
  return keys.some((key) => {
    if (key.startsWith(hintKey) || hintKey.startsWith(key)) return true;
    return key.split('-').some((token) => token !== '' && hintTokens.has(token));
  });
}

function suggestionsFor(entry: ProjectEntry, evidence: Evidence): ProjectSuggestion[] {
  const suggestions: ProjectSuggestion[] = [];
  const { record } = entry;

  if (
    evidence.directoryPath !== undefined &&
    evidence.directoryKey !== undefined &&
    !projectDirectoryKeys(record).includes(evidence.directoryKey)
  ) {
    suggestions.push({ field: 'working_directories', value: evidence.directoryPath });
  }
  if (
    evidence.remote !== undefined &&
    !(record.identifiers?.git_remotes ?? []).includes(evidence.remote)
  ) {
    suggestions.push({ field: 'git_remotes', value: evidence.remote });
  }
  if (
    evidence.slug !== undefined &&
    !(record.identifiers?.repository_slugs ?? []).includes(evidence.slug)
  ) {
    suggestions.push({ field: 'repository_slugs', value: evidence.slug });
  }
  return suggestions;
}

async function normalizeEvidence(input: ResolveProjectInput): Promise<Evidence> {
  const directoryPath = await normalizeOptionalDirectory(input.working_directory);
  return {
    directoryPath,
    directoryKey: directoryPath === undefined ? undefined : workingDirectoryKey(directoryPath),
    remote: input.git_remote === undefined ? undefined : normalizeGitRemote(input.git_remote),
    slug:
      input.repository_slug === undefined
        ? undefined
        : normalizeRepositorySlug(input.repository_slug),
    // An unnameable hint (punctuation only) normalizes to an empty key, which
    // would prefix-match every project. Treat it as no hint at all.
    nameHintKey: input.name_hint === undefined ? undefined : nameKey(input.name_hint),
  };
}

function summarize(entries: readonly ProjectEntry[]): ProjectSummary[] {
  return entries
    .map((entry) => toProjectSummary(entry.record))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
