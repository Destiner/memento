import { MementoError } from '../errors.js';

// Search normalization is separate from dedupe's broad OR query. Missing content
// words stay in the evidence denominator; they must not silently disappear.
const STOP_WORDS = new Set(
  `a an the and or of to in on at by for from with as is are was were be been being
   do does did have has had it its this that these those we our us i you your they
   their them he she his her what which who how why when where can could should
   would will may might must shall than then so if into about only both each
   after before during through also not no s`.split(/\s+/),
);

export const MAX_SEARCH_TERMS = 64;
export const MAX_SEARCH_QUERY_LENGTH = 4096;
const MAX_CLAUSES = 8;

export interface QueryClause {
  terms: string[];
  literals: string[];
}

export interface SearchQuery {
  terms: string[];
  clauses: QueryClause[];
}

export function searchQuery(raw: string): SearchQuery {
  if (raw.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new MementoError(
      'validation_error',
      `Search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters.`,
    );
  }
  const clause = (text: string): QueryClause => {
    const literals = searchLiterals(text);
    return {
      terms: [...new Set([...contentTerms(text), ...literals.flatMap(literalTerms)])],
      literals,
    };
  };
  const whole = clause(raw);
  assertTermBudget(whole.terms.length);
  // Do not split plain keyword lists or phrases such as "cache and invalidation".
  // A new interrogative is an explicit boundary between information needs.
  const masked = raw.replace(/`([^`\n]+)`|"([^"\n]+)"/gu, (span) => ' '.repeat(span.length));
  const boundaries = masked.matchAll(
    /[;?\n]+|\b(?:and|also)\s+(?=(?:(?:at|in|for|to)\s+)?(?:how|why|what|which|when|where)\b)/giu,
  );
  const parts: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    parts.push(raw.slice(start, boundary.index));
    start = boundary.index + boundary[0].length;
    if (parts.length >= MAX_CLAUSES - 1) break;
  }
  parts.push(raw.slice(start));
  return {
    terms: whole.terms,
    clauses: [whole, ...parts.slice(0, MAX_CLAUSES).map(clause)].filter(
      (part, i, all) =>
        part.terms.length > 0 &&
        all.findIndex(
          (other) =>
            other.terms.join('\0') === part.terms.join('\0') &&
            other.literals.join('\0') === part.literals.join('\0'),
        ) === i,
    ),
  };
}

export function literalTerms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}

function contentTerms(text: string): string[] {
  return [...new Set(literalTerms(text).filter((term) => !STOP_WORDS.has(term)))];
}

export function assertTermBudget(count: number): void {
  if (count > MAX_SEARCH_TERMS) {
    throw new MementoError(
      'validation_error',
      `Search query exceeds ${MAX_SEARCH_TERMS} distinct terms.`,
    );
  }
}

// Quoted references are atomic; code fragments inside them are not alternatives.
function searchLiterals(text: string): string[] {
  const quoted: string[] = [];
  const prose = text.replace(/`([^`\n]+)`|"([^"\n]+)"/gu, (_, backtick: string, quote: string) => {
    quoted.push(backtick ?? quote);
    return ' ';
  });
  const code = (prose.match(/(?:--)?[\p{L}\p{N}][\p{L}\p{N}\p{M}_./+#-]*/gu) ?? [])
    .map((word) => word.replace(/\.+$/u, ''))
    .filter(
      (word) => /[_/]|\.[\p{L}\p{N}]|\+\+|#|^--/u.test(word) || /\p{Ll}\p{Lu}\p{Ll}/u.test(word),
    );
  return [...new Set([...quoted, ...code].map((word) => word.trim()).filter(Boolean))];
}

export function literalPattern(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Paths and flags need continuation guards. Plain identifiers may precede a
  // member access or executable extension (worker_loop.run / worker_loop.sh).
  const continuation = /[./\\]|^--/u.test(literal)
    ? String.raw`|[./\\-][\p{L}\p{N}\p{M}_./\\+#-]`
    : '';
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_+#-])${escaped}(?![\\p{L}\\p{N}\\p{M}_+#]${continuation})`,
    'iu',
  );
}

export function matchesLiteral(text: string, literal: string): boolean {
  return literalPattern(literal).test(text);
}

export function matchExpression(terms: readonly string[], join = ' OR '): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(join);
}
