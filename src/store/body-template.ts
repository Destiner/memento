// The memory body template (§7). The `## Summary` section is load-bearing:
// answer_memory synthesizes from it and degrades to a truncated FTS excerpt when
// it is absent. Both the create-time guard and answer-time extraction share this
// single detector so the guarantee "if create accepted it, answer will find it"
// cannot drift.

// Capture the text under a `## Summary` heading up to the next `## ` heading or
// end of body. Returns null when the section is absent or empty.
export function extractSummary(body: string): string | null {
  const match = /##\s+Summary\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  const text = match?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

export function hasSummarySection(body: string): boolean {
  return extractSummary(body) !== null;
}
