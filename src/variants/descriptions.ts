// Tool-description sets for the MEMENTO_VARIANT switch (harness knob: "Tool
// descriptions", §3.1). Each set maps every tool to the `description` the server
// registers for it. The descriptions knob is an ablation with two sets:
//
//   plain        — neutral/terse mechanics only, no when-to-use guidance. This is
//                  the harness's baseline-0 floor (§10).
//   triggerList  — today's shipped text, which embeds implementer-spec §11
//                  when-to-query/when-to-capture guidance (commit 8db547f).
//                  Measured from the plain floor, this is the knob's strong arm.

export type ToolName =
  'create_memory' | 'read_memory' | 'update_memory' | 'search_memory' | 'answer_memory';

export type DescriptionSet = Record<ToolName, string>;

// Neutral floor: what each tool does, with no propensity guidance. baseline-0.
export const plainDescriptions: DescriptionSet = {
  create_memory: 'Create a memory as a canonical markdown file from the given metadata and body.',
  read_memory: 'Read one memory in full by its stable ID.',
  update_memory:
    'Edit an existing memory in place: apply metadata changes and/or a body edit ' +
    '(an exact-match old_text/new_text replacement or a full-body replacement).',
  search_memory:
    'Search stored memories by plain-language query plus optional structured ' +
    'filters. Returns ranked results with excerpts.',
  answer_memory:
    'Answer a question from stored memories: returns a synthesized answer with ' +
    'source IDs, a confidence level, and a caveat.',
};

// Shipped descriptions — implementer-spec §11 guidance embedded in prose. Kept
// identical to the strings previously inlined in server.ts (commit 8db547f).
export const triggerListDescriptions: DescriptionSet = {
  create_memory:
    'Create a durable, cross-task memory as a canonical markdown file. ' +
    'Create only when a reusable insight emerged that is not repo-owned truth ' +
    '(architecture rationale, third-party service quirks, cross-repo decisions, ' +
    'testing strategy, incident learnings). Prefer update_memory over creating a ' +
    'near-duplicate. Do not record repo-local facts (they belong in the repository) ' +
    'or routine task status.',
  read_memory:
    'Read one memory in full by its stable ID. Use to pull up the complete ' +
    'content of a promising result after search_memory, not to browse.',
  update_memory:
    'Edit an existing memory in place (metadata changes and/or an exact-match ' +
    'body edit). Prefer this over create_memory when the insight already exists ' +
    'and needs correcting, extending, or a status/confidence change.',
  search_memory:
    'Search stored memories by plain-language query plus optional filters. ' +
    'Run one targeted search at the start of a nontrivial task involving ' +
    'planning or architecture, cross-repo work, product rationale, third-party ' +
    'services, testing strategy, or incident triage, then read only the top one ' +
    'or two results. Do not search for simple, self-contained edits, and treat ' +
    'code and current repository docs as more authoritative than memory.',
  answer_memory:
    'Ask an answer-shaped question and get a compact, source-backed answer ' +
    'synthesized from stored memories, with source IDs and a caveat. Use when ' +
    'you want a direct answer rather than a ranked list; the same when-to-query ' +
    'guidance as search_memory applies.',
};
