// The shared near-duplicate scorer behind both creation gates (v2.md §5).
//
// `create_memory` and `create_project` face one problem from opposite ends: an
// agent that failed to find the existing record is about to add a second one for
// the same thing. Exact collisions are caught by equality — a project name key, a
// memory id. What is left is semantic near-duplication, which is a judgement
// call, so the store's job is to surface the neighbours and let the agent decide
// (docs/memory-policy.md §11).
//
// Deliberately lexical and dependency-free: token-set Dice over normalized text.
// No stemming, no embeddings. Two properties matter more than recall here —
// determinism, so a threshold can be pinned by a test, and symmetry, so the gate
// does not depend on which record was written first. This module only scores
// *pairs*; the candidate pool comes from FTS (memories) or from the whole
// registry (projects), which is small enough to scan.

import { nameKey } from './project-normalize.js';

/**
 * Gate thresholds. Deliberately different, because the two sides fail
 * differently: a duplicate project splits an identity and every memory written
 * against it afterwards, while a duplicate memory is one weaker retrieval result.
 * Both gates are soft — they return candidates and can be overridden with a
 * reason — so the cost of firing too eagerly is one extra round-trip.
 */
export const MEMORY_DUPLICATE_THRESHOLD = 0.55;
export const PROJECT_DUPLICATE_THRESHOLD = 0.6;

/** How many neighbours a gated create reports back, best-scoring first. */
export const DUPLICATE_CANDIDATE_LIMIT = 5;

// Words that carry no discriminating signal in a title or a one-line summary.
// Short on purpose: an over-eager stopword list erases the difference between
// "retries after a timeout" and "retries before a timeout".
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

const MIN_TOKEN_LENGTH = 2;

const MEMORY_TITLE_WEIGHT = 0.6;
const MEMORY_DESCRIPTION_WEIGHT = 0.4;

const PROJECT_NAME_WEIGHT = 0.7;
const PROJECT_DESCRIPTION_WEIGHT = 0.3;

export interface ComparableMemory {
  title: string;
  description: string;
}

export interface ComparableProject {
  name: string;
  aliases?: readonly string[];
  description: string;
}

/**
 * Split text into comparison tokens: diacritics folded, lowercased, split on
 * anything that is not a letter or digit, stopwords and single characters
 * dropped.
 *
 * The split is unicode-aware rather than `[a-z0-9]`, so a non-latin title
 * produces tokens instead of an empty set (which would silently disable the gate
 * for it).
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritical marks
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Sørensen-Dice coefficient over two token sets: `2|A∩B| / (|A|+|B|)`.
 *
 * An empty set scores 0, including when both are empty: two titles that survive
 * tokenization as nothing are not evidence of duplication, and returning 1 there
 * would gate every such pair against every other.
 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  return (2 * shared) / (a.size + b.size);
}

/** Overlap coefficient: `|A∩B| / min(|A|,|B|)`, so a strict subset scores 1. */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  return shared / small.size;
}

export function textSimilarity(a: string, b: string): number {
  return dice(tokenSet(a), tokenSet(b));
}

/**
 * How alike two memories are, in `[0,1]`.
 *
 * An identical title short-circuits to 1: agents that re-derive the same insight
 * tend to name it the same way, and the descriptions then differ only in wording.
 * Otherwise title and description are scored separately and weighted so that the
 * description cannot reach the gate on its own — two memories about one subject
 * share context, and only agreement on what the memory *says* should gate a write.
 */
export function memorySimilarity(a: ComparableMemory, b: ComparableMemory): number {
  const titleKey = nameKey(a.title);
  if (titleKey !== '' && titleKey === nameKey(b.title)) return 1;

  return (
    MEMORY_TITLE_WEIGHT * textSimilarity(a.title, b.title) +
    MEMORY_DESCRIPTION_WEIGHT * textSimilarity(a.description, b.description)
  );
}

/**
 * How alike two projects are, in `[0,1]`.
 *
 * Names are compared with containment as well as Dice, which memory titles are
 * not. A project name is a label of one or two tokens, so `api` against
 * `api-server` is the exact shape that splits an identity, and Dice alone scores
 * it 0.67 — under the gate. Containment scores a strict subset 1, which errs
 * toward showing the agent a candidate it can override with a reason.
 *
 * Every name and alias is compared, because an alias exists precisely so the
 * project answers to it.
 */
export function projectSimilarity(a: ComparableProject, b: ComparableProject): number {
  return (
    PROJECT_NAME_WEIGHT * bestLabelSimilarity(labels(a), labels(b)) +
    PROJECT_DESCRIPTION_WEIGHT * textSimilarity(a.description, b.description)
  );
}

function labels(project: ComparableProject): string[] {
  return [project.name, ...(project.aliases ?? [])];
}

function bestLabelSimilarity(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (const left of a) {
    const leftTokens = tokenSet(left);
    for (const right of b) {
      const rightTokens = tokenSet(right);
      const score = Math.max(dice(leftTokens, rightTokens), containment(leftTokens, rightTokens));
      if (score > best) best = score;
    }
  }
  return best;
}
