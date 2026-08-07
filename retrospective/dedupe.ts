// Collapsing repeated proposals for one opportunity (V2 item 9).
//
// Search checkpoints are evaluated independently from the transcript prefix
// ending at each one, which is what keeps the evaluation honest: the judge for
// checkpoint 2 cannot see what the agent did after checkpoint 2. The cost of
// that independence is repetition — an opportunity that is present for a whole
// task is proposed again at every checkpoint that follows it.
//
// Comparison is one-to-one, so at most one member of such a set can ever be
// matched to an actual operation and the rest are classified `missed` no matter
// how the agent behaved. Left alone, that makes the missed count scale with
// checkpoint count instead of with behaviour, and makes two tasks of different
// lengths incomparable. Grouping restores the intended denominator: one
// opportunity, counted once.
//
// The grouping is deterministic and local — no model call — because run
// identity and resumption depend on the same inputs producing the same result.

import type { SearchProposal } from './evaluator/schema.js';

/**
 * Similarity at or above which two proposals are treated as one opportunity.
 *
 * Deliberately set high. A false merge hides a real finding from review, while a
 * false split only costs one extra review decision, so the asymmetry argues for
 * keeping borderline pairs apart.
 *
 * KNOWN LIMIT — this catches near-verbatim repeats, not paraphrases. Measured on
 * run_dc75ce89, whose ten proposals covered roughly three opportunities: the two
 * verbatim repeats score 1.00 and 0.52, while genuine paraphrases of the same
 * question score 0.10-0.46 on query tokens. No threshold separates those from
 * distinct opportunities, because the paraphrases sit *below* several unrelated
 * pairs — one proposal is 0.30-0.35 from members of two different clusters, so
 * lowering the bar chains those clusters together instead of collapsing them.
 *
 * So this pass removes the mechanical inflation — an identical query reproposed
 * at later checkpoints — and leaves semantic repetition to the reviewer. Closing
 * the rest needs a judge rather than a threshold: one grouping call per task over
 * the finished proposal set, which spends tokens and adds a prompt version to run
 * identity. Do not tune this constant against a single corpus.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.5;

/** Shortest token kept when comparing proposals. */
const MIN_TOKEN_LENGTH = 3;

export interface DedupeCandidate {
  /** Index into the caller's proposal list. */
  index: number;
  /** Whether comparison already matched this proposal to an actual operation. */
  matched: boolean;
  tokens: ReadonlySet<string>;
  scopeKind: string;
}

/**
 * Map each duplicate proposal index to the index representing its opportunity.
 *
 * Candidates are visited in the caller's order, which is checkpoint order, so
 * the representative of a group is the earliest proposal unless a later one was
 * matched to a real operation — a matched proposal describes something that
 * actually happened, and is the more useful row to keep in the queue.
 *
 * A matched proposal is never recorded as a duplicate. Two matches inside one
 * group mean the agent really did search twice for the same thing, and
 * collapsing them would erase the second operation.
 */
export function assignDuplicates(candidates: readonly DedupeCandidate[]): Map<number, number> {
  interface Group {
    seedTokens: ReadonlySet<string>;
    scopeKind: string;
    members: DedupeCandidate[];
  }

  const groups: Group[] = [];
  for (const candidate of candidates) {
    const group = groups.find(
      (existing) =>
        existing.scopeKind === candidate.scopeKind &&
        jaccard(existing.seedTokens, candidate.tokens) >= DUPLICATE_SIMILARITY_THRESHOLD,
    );
    if (group) group.members.push(candidate);
    else
      groups.push({
        seedTokens: candidate.tokens,
        scopeKind: candidate.scopeKind,
        members: [candidate],
      });
  }

  const duplicates = new Map<number, number>();
  for (const group of groups) {
    if (group.members.length < 2) continue;
    const representative = group.members.find((member) => member.matched) ?? group.members[0]!;
    for (const member of group.members) {
      if (member === representative || member.matched) continue;
      duplicates.set(member.index, representative.index);
    }
  }
  return duplicates;
}

/**
 * Comparison tokens for a search proposal: its query, and nothing else.
 *
 * `intent` and `rationale` are both excluded, for the same reason: they are prose
 * written per checkpoint, and they vary with the surrounding transcript even when
 * the opportunity is identical. Folding them in does not merely add noise, it
 * masks real repeats — on run_dc75ce89 two proposals with identical query tokens
 * scored 1.00 on the query alone and 0.36 once their intents were included.
 *
 * The query is also the operative field: it is what would have been passed to
 * `search_memories`, so two proposals with the same query are the same request.
 */
export function searchProposalTokens(proposal: SearchProposal): ReadonlySet<string> {
  return tokenize(proposal.search.query);
}

function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    // Fold the trailing plural so `secret` and `secrets` compare equal. Crude on
    // purpose: a real stemmer would be a dependency and a source of surprise.
    tokens.add(raw.endsWith('s') && raw.length > MIN_TOKEN_LENGTH ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}
