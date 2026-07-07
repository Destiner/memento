// Server `instructions` text for the MEMENTO_VARIANT switch (harness knob: "MCP
// server instructions field", §3.1). When set, the MCP client hoists this into
// the agent's system prompt. Content condenses the implementer-spec §11 decision
// loop and failure modes; `baseline` leaves instructions empty.

export const USAGE_PROTOCOL =
  'Memento is a durable, cross-task memory layer that persists insights across ' +
  'sessions and repositories.\n\n' +
  'Before starting a nontrivial task — planning or architecture, cross-repo ' +
  'work, product rationale, third-party services, testing strategy, or incident ' +
  'triage — run one targeted search_memory and read only the top one or two ' +
  'results. Do not search for simple, self-contained edits.\n\n' +
  'Treat code and current repository docs as more authoritative than memory. ' +
  'After the task, create or update a memory only if a durable, cross-task ' +
  'insight emerged; never for routine task status or repo-local facts.';
