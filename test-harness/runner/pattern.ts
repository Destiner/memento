// Scenario check patterns (utility_regex, insight_regex, …) are authored in
// PCRE-style with inline flags, e.g. `(?i)postmark`. JavaScript's RegExp rejects a
// bare `(?flags)` prefix, so lift a leading flag group into the flags argument,
// keeping only the flags JS supports. Everything after the prefix is passed
// through verbatim.

export function compilePattern(pattern: string): RegExp {
  const match = /^\(\?([a-z]+)\)/.exec(pattern);
  if (!match) return new RegExp(pattern);
  const flags = [...(match[1] ?? '')].filter((flag) => 'gimsuy'.includes(flag)).join('');
  return new RegExp(pattern.slice(match[0].length), flags);
}
