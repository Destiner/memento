// Tool-description sets for the MEMENTO_VARIANT switch (harness knob: "Tool
// descriptions"). Each set maps every tool to the `description` the server
// registers for it. The descriptions knob is an ablation with two sets:
//
//   plain        — neutral/terse mechanics only, no when-to-use guidance. This is
//                  the harness's baseline-0 floor.
//   triggerList  — the same mechanics plus when-to-use guidance derived from
//                  `memory-policy.md` §4 and §5.
//
// These are the V2 tool surface, ported so the server has correct text for every
// registered tool. The final wording is item 6's job: it regenerates both sets
// from `memory-policy.md` so terminology cannot drift from the canonical policy
// (§12 lists this file as a derived surface).

export type ToolName =
  | 'resolve_project'
  | 'create_project'
  | 'update_project'
  | 'search_memories'
  | 'get_memory'
  | 'create_memory'
  | 'update_memory'
  | 'archive_memory';

export type DescriptionSet = Record<ToolName, string>;

// Neutral floor: what each tool does, with no propensity guidance. baseline-0.
export const plainDescriptions: DescriptionSet = {
  resolve_project:
    'Map evidence about the current work — a working directory, git remote, ' +
    'repository slug, or name — onto a registered project id. Read-only.',
  create_project:
    'Register a new project and return its stable id. Returns candidate matches ' +
    'instead of creating when an existing project looks like the same thing.',
  update_project:
    'Edit a registered project in place: name, description, aliases, git ' +
    'identifiers, working directories, or status. The project id never changes.',
  search_memories:
    'Search stored memories within an explicit project or global scope. Returns ' +
    'ranked summaries without bodies.',
  get_memory: 'Read one memory in full by its stable id, including body and provenance.',
  create_memory:
    'Create a memory as a canonical markdown file. Returns near-duplicate ' +
    'candidates instead of creating when one already covers the same knowledge.',
  update_memory:
    'Edit an existing memory in place: metadata changes, a body edit (exact-match ' +
    'old_text/new_text or full replacement), or a re-verification stamp.',
  archive_memory: 'Archive a memory with a reason. Soft deletion; the file is kept.',
};

// Trigger-list arm: the same mechanics plus the policy's when-to-use guidance.
export const triggerListDescriptions: DescriptionSet = {
  resolve_project:
    'Map evidence about the current work — a working directory, git remote, ' +
    'repository slug, or name — onto a registered project id. Read-only. Call this ' +
    'before any project-scoped search or write, and never invent a project id or ' +
    'pass a path or name in its place. On an exact match with suggestions, apply ' +
    'them with update_project; on candidates, reuse one rather than creating a ' +
    'second project; only on not_found call create_project.',
  create_project:
    'Register a new project and return its stable id. Call this only after ' +
    'resolve_project returned not_found. An existing project that looks like the ' +
    'same thing comes back as candidates and nothing is written: reuse one, or ' +
    'pass force_create with a reason if it is genuinely distinct. A moved ' +
    'checkout, a new remote, or a rename is an update_project, never a new project.',
  update_project:
    'Edit a registered project in place: name, description, aliases, git ' +
    'identifiers, working directories, or status. Use this when a checkout moved, ' +
    'a repository gained a remote, or a project was renamed — the id, and every ' +
    'memory scoped to it, survives. Array fields append by default.',
  search_memories:
    'Search stored memories within an explicit project or global scope. Run one ' +
    'targeted search, unprompted, before debugging anything non-obvious or ' +
    'recurring, work spanning more than one project, a decision that may already ' +
    'have a rationale, work a product or customer constraint might govern, work ' +
    'involving a third-party service, planning or migration or testing strategy, ' +
    'or unexpected environment behaviour. Read the top one or two results and ' +
    'stop. Do not search for simple self-contained edits, and treat code and ' +
    'current repository docs as more authoritative than memory. Returns summaries; ' +
    'call get_memory for the full content of a relevant result.',
  get_memory:
    'Read one memory in full by its stable id, including body and provenance. Use ' +
    'to pull up a promising result after search_memories, not to browse.',
  create_memory:
    'Create a memory holding durable, non-obvious context that is not repo-owned ' +
    'truth: a reusable root cause, why something is the way it is or why an ' +
    'alternative was rejected, a relationship between projects, a durable ' +
    'preference, or an environment quirk that cost real time. Search first. Do not ' +
    'store task status, facts derivable from the repository, copied documentation, ' +
    'unresolved speculation, or secrets. A near-duplicate comes back as candidates ' +
    'and nothing is written: prefer update_memory on the closest match, and pass ' +
    'force_create with a reason only when the new memory is materially distinct.',
  update_memory:
    'Edit an existing memory in place: metadata changes, a body edit (exact-match ' +
    'old_text/new_text or full replacement), or a re-verification stamp. Prefer ' +
    'this over create_memory whenever an existing memory expresses substantially ' +
    'the same knowledge, and use it to correct a memory that code or current docs ' +
    'have contradicted.',
  archive_memory:
    'Archive a memory with a reason, when it no longer holds and updating it will ' +
    'not do. Soft deletion: the memory stays readable and recoverable, and stops ' +
    'appearing in normal search. Restore by updating its status back to active.',
};
