// Tool-result nudges for the MEMENTO_VARIANT switch (harness knob: "Tool-result
// nudges", §3.1). When a nudge is set, the server appends it as an extra text
// block on the relevant tool result — the structured payload is untouched.
// `baseline` sets no nudges (plain results).

export interface NudgeSet {
  // Appended to search_memory results that returned zero matches.
  emptySearch?: string;
  // Appended to a successful create_memory result.
  createSuccess?: string;
}

export const EMPTY_SEARCH_NUDGE =
  'No memories matched. If this task surfaces a durable, cross-task insight, ' +
  'consider create_memory once you are done.';

export const CREATE_SUCCESS_NUDGE =
  'Memory saved. For future tasks like this one, run search_memory first to ' +
  'reuse what you have stored.';
