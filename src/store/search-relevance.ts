import { literalPattern, type QueryClause } from './search-query.js';

export const SEARCH_RANKER_VERSION = 'lexical-evidence-v1';

export interface TermMatch {
  term: string;
  id: string;
  column: string;
}

export interface LexicalDocument {
  id: string;
  title: string;
  description: string;
  body: string;
}

export interface SearchEvidence {
  accepted: boolean;
  score: number;
  matchedTerms: number;
  exactLiteral: boolean;
}

// Coverage gates relevance before metadata tie-breaking. It is not a calibrated
// probability, and a body match must remain sufficient for curated identifiers.
const MIN_COVERAGE = 0.3;
const FIELD_WEIGHT: Record<string, number> = { title: 1, description: 0.9, body: 0.75 };

export function lexicalEvidence(
  clauses: QueryClause[],
  matches: TermMatch[],
  eligibleCount: number,
): (doc: LexicalDocument) => SearchEvidence {
  const documents = new Map<string, Map<string, number>>();
  const frequencies = new Map<string, Set<string>>();
  for (const match of matches) {
    const terms = documents.get(match.id) ?? new Map<string, number>();
    terms.set(match.term, Math.max(terms.get(match.term) ?? 0, FIELD_WEIGHT[match.column] ?? 0));
    documents.set(match.id, terms);
    const ids = frequencies.get(match.term) ?? new Set<string>();
    ids.add(match.id);
    frequencies.set(match.term, ids);
  }
  const weight = (term: string) =>
    1 + Math.log((eligibleCount + 1) / ((frequencies.get(term)?.size ?? 0) + 1));

  const prepared = clauses.map((clause) => {
    const terms = [...new Set(clause.terms)].map((term) => ({ term, weight: weight(term) }));
    return {
      terms,
      total: terms.reduce((sum, term) => sum + term.weight, 0),
      literals: clause.literals.map(literalPattern),
    };
  });

  return (doc) => {
    const matched = documents.get(doc.id) ?? new Map<string, number>();
    const text = `${doc.title}\n${doc.description}\n${doc.body}`;
    let best = 0;
    let whole = 0;
    let accepted = false;
    let exactLiteral = false;
    prepared.forEach(({ terms, total, literals }, i) => {
      if (!terms.length) return;
      const present = terms.filter(({ term }) => matched.has(term));
      const coverage = present.reduce((sum, term) => sum + term.weight, 0) / total;
      const strength =
        present.reduce((sum, { term, weight }) => sum + weight * matched.get(term)!, 0) / total;
      const literal = literals.length > 0 && literals.every((pattern) => pattern.test(text));
      // A code-like subject must actually occur, not just its punctuation-stripped
      // tokens (e.g. C++ versus C#, or a missing option alongside generic words).
      if (literals.length && !literal) return;
      exactLiteral ||= literal;
      accepted ||=
        literal || (present.length >= Math.min(2, terms.length) && coverage >= MIN_COVERAGE);
      const score = literal ? Math.max(0.85, strength) : strength;
      if (i === 0) whole = score;
      best = Math.max(best, score);
    });
    return {
      accepted,
      score: Math.min(1, Math.max(0, 0.8 * best + 0.2 * whole)),
      matchedTerms: matched.size,
      exactLiteral,
    };
  };
}
