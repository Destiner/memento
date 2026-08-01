// The two prose surfaces, assembled from `blocks.ts` (policy §12):
//
//   SERVER_INSTRUCTIONS — the MCP `instructions` field. The client hoists it into
//                         the agent's system prompt, so it carries the rules that
//                         must hold before any tool is called: the boundary, the
//                         §4 triggers in full, project resolution, the write bar,
//                         and the type enum with its meanings.
//   AGENT_FRAGMENT      — the snippet a user pastes into AGENTS.md / CLAUDE.md.
//                         Two short paragraphs: the strongest activation channel
//                         is also the one competing hardest for attention, so it
//                         compresses the trigger lists and names the types
//                         without defining them. `memento instructions` prints it.
//
// Neither surface states a rule that `docs/memory-policy.md` does not; compressions are
// declared in blocks.ts and checked by `test/policy.test.ts`.

import {
  CODE_WINS,
  CODE_WINS_COMPACT,
  DO_NOT_STORE,
  DO_NOT_STORE_COMPACT,
  DUPLICATES,
  DUPLICATES_COMPACT,
  ELIGIBILITY_TESTS,
  ESTABLISHED,
  PROACTIVITY,
  PROJECT_RESOLUTION,
  PURPOSE,
  PURPOSE_COMPACT,
  REPO_OWNS,
  ROUTING,
  SCOPE_RULE,
  SEARCH_ANTI_TRIGGERS,
  SEARCH_DISCIPLINE,
  SEARCH_TRIGGERS,
  SEARCH_TRIGGERS_COMPACT,
  TYPE_LINES,
  TYPE_NAMES,
  WRITE_TRIGGERS,
  WRITE_TRIGGERS_COMPACT,
} from './blocks.js';

/** Join clauses with `sep`, optionally leading the last one with a conjunction. */
export function joinClauses(
  clauses: readonly string[],
  sep: ', ' | '; ',
  conjunction?: 'and' | 'or',
): string {
  if (clauses.length < 2 || conjunction === undefined) return clauses.join(sep);
  const last = clauses[clauses.length - 1];
  return `${clauses.slice(0, -1).join(sep)}${sep}${conjunction} ${last}`;
}

const clausesOf = (items: readonly { clause: string }[]): string[] =>
  items.map((item) => item.clause);

// Everything except `duplicate`, which the neighbouring §11 sentence already says
// operationally ("extend a same-scope near-match").
const doNotStoreClauses = clausesOf(DO_NOT_STORE.filter((rule) => rule.key !== 'duplicate'));

const typeCatalogue = Object.entries(TYPE_LINES)
  .map(([type, holds]) => `\`${type}\` — ${holds}.`)
  .join(' ');

const boundaryParagraph = `${PURPOSE} ${REPO_OWNS} ${CODE_WINS}`;

const searchParagraph =
  `${PROACTIVITY} Search before: ${joinClauses(clausesOf(SEARCH_TRIGGERS), '; ', 'and')}. ` +
  `${SEARCH_DISCIPLINE} ${SEARCH_ANTI_TRIGGERS}`;

const writeParagraph =
  `Create or update a memory ${ESTABLISHED} ` +
  `${joinClauses(clausesOf(WRITE_TRIGGERS), '; ', 'or')}. All four of these must hold: ` +
  `${joinClauses(clausesOf(ELIGIBILITY_TESTS), ', ', 'and')}. ${DUPLICATES} ` +
  `Never store ${joinClauses(doNotStoreClauses, '; ', 'or')}.`;

const taxonomyParagraph = `Exactly one type per memory. ${typeCatalogue} ${ROUTING} ${SCOPE_RULE}`;

export const SERVER_INSTRUCTIONS = [
  boundaryParagraph,
  searchParagraph,
  PROJECT_RESOLUTION,
  writeParagraph,
  taxonomyParagraph,
].join('\n\n');

// --- The AGENTS.md / CLAUDE.md fragment ------------------------------------

const FRAGMENT_WIDTH = 80;

/** Hard-wrap a paragraph so the pasted fragment reads like hand-written notes. */
function wrap(paragraph: string, width = FRAGMENT_WIDTH): string {
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(' ')) {
    if (line === '') {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

const fragmentSearch =
  `${PURPOSE_COMPACT} Search it unprompted before ` +
  `${joinClauses(clausesOf(SEARCH_TRIGGERS_COMPACT), ', ', 'or')}: one targeted ` +
  '`search_memories`, read the top one or two results, stop. Skip it for simple ' +
  `self-contained edits, and ${CODE_WINS_COMPACT}.`;

const fragmentCapture =
  'Capture unprompted once something is established rather than suspected: ' +
  `${joinClauses(clausesOf(WRITE_TRIGGERS_COMPACT), ', ')}. ${DUPLICATES_COMPACT}, and ` +
  `never store ${joinClauses(clausesOf(DO_NOT_STORE_COMPACT), ', ', 'or')}. Types: ` +
  `${TYPE_NAMES.map((type) => `\`${type}\``).join(', ')}.`;

export const AGENT_FRAGMENT = `## Memory (memento)

${wrap(fragmentSearch)}

${wrap(fragmentCapture)}
`;
