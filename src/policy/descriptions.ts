// Tool-description sets, assembled from `blocks.ts` (policy §12).
//
// The descriptions knob is an ablation with two sets:
//
//   plain        — neutral mechanics only, no when-to-use guidance. This is the
//                  harness's baseline-0 floor, so it is hand-written and stays
//                  byte-stable: regenerating it would move the line every knob is
//                  measured against.
//   triggerList  — the same mechanics plus the policy's triggers, prerequisites,
//                  and recovery paths. Each entry answers five questions: what the
//                  tool does, when to call it, when not to, what must happen first,
//                  and what to do with the result it returns.
//
// A description is read at the moment of the call, which makes it the right place
// for mechanics (outcomes, field names, escape hatches) that would be noise in the
// system prompt. Type *meanings* live only in the server instructions; the input
// schema already enumerates the names.

import {
  DO_NOT_STORE,
  SEARCH_ANTI_TRIGGERS,
  SEARCH_TRIGGERS,
  WRITE_TRIGGERS_COMPACT,
} from './blocks.js';
import { joinClauses } from './instructions.js';

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

const searchTriggerList = joinClauses(
  SEARCH_TRIGGERS.map((trigger) => trigger.clause),
  '; ',
  'and',
);

// `duplicate` is omitted: the dedupe sentence that follows it here is the same
// rule stated as a recovery path.
const doNotStoreList = joinClauses(
  DO_NOT_STORE.filter((rule) => rule.key !== 'duplicate').map((rule) => rule.clause),
  '; ',
  'or',
);

const writeTriggerList = joinClauses(
  WRITE_TRIGGERS_COMPACT.map((trigger) => trigger.clause),
  ', ',
  'or',
);

// Trigger-list arm: mechanics plus the policy's when-to-use guidance.
export const triggerListDescriptions: DescriptionSet = {
  resolve_project:
    'Map evidence you already have — `working_directory`, `git_remote`, ' +
    '`repository_slug`, or `name_hint` — onto a registered project id. Read-only: it ' +
    'never creates or edits anything. Call it before every project-scoped search or ' +
    'write; ids are opaque `prj_` strings and a path or name is never accepted in ' +
    'their place. Outcomes: `exact_match` — use `project.id`, and apply any ' +
    '`suggestions` with update_project; `candidates` — inspect them and reuse the ' +
    'right one, since a second project for one codebase splits its memories in half; ' +
    '`not_found` — only then call create_project. `matched_on` says whether a working ' +
    'directory matched or a name was guessed, so weigh a name-only hit before ' +
    'trusting it.',
  create_project:
    'Register a project and return its stable id. Writes a project record. Call it ' +
    'only after resolve_project returned `not_found`. Never call it for a moved ' +
    'checkout, a repository that gained a remote, or a rename — those are ' +
    'update_project, and creating instead strands every memory scoped to the existing ' +
    'id. Supply `name`, `description`, and whatever identifiers you have (`aliases`, ' +
    '`identifiers.git_remotes`, `identifiers.repository_slugs`, `working_directories`) ' +
    'so the next session resolves without guessing. On `duplicate_candidates` nothing ' +
    'was written: reuse a candidate, or repeat the call with `force_create` and ' +
    '`force_create_reason` when it is genuinely a different project. An exact name or ' +
    'working-directory collision is an error naming the owner, not a candidate list.',
  update_project:
    'Edit a registered project in place: `name`, `description`, `aliases`, ' +
    '`identifiers`, `working_directories`, or `status`. The id never changes, so every ' +
    'memory scoped to it survives. Call it when a checkout moved, a repository gained ' +
    'a remote, a project was renamed (keep the old name as an alias), or ' +
    'resolve_project returned `suggestions` to apply. Array fields append and dedupe ' +
    'by default; pass `replace: true` only when you mean to drop the values you are ' +
    'not sending. Not for creating a project, and not for retiring a memory.',
  search_memories:
    'Search stored memories by text within an explicit scope. Returns ranked ' +
    'summaries — id, title, description, type, scope, status — and no bodies. Run one ' +
    `targeted search, unprompted, before: ${searchTriggerList}. ${SEARCH_ANTI_TRIGGERS} ` +
    'Scope is required: `projects` with resolved ids (`match: any` by default, `all` ' +
    'for knowledge shared by every one) or `global` — a projects search never returns ' +
    'global memories, so preferences need their own call. Archived memories are ' +
    'excluded unless `status` asks for them. Read the top one or two results, call ' +
    'get_memory on a promising one, and stop; zero results is a normal answer, not a ' +
    'reason to rephrase and retry. Code and current repository docs outrank whatever ' +
    'comes back.',
  get_memory:
    'Read one memory in full by its stable id: body, provenance, timestamps, archive ' +
    'reason, and the names behind its opaque project ids. Call it on a search result ' +
    'that looks relevant, since search returns summaries without bodies. Not a browse ' +
    'or list tool — it takes an exact id, and ids come from search_memories or from a ' +
    'create/update result. If what you read contradicts current code or repository ' +
    'docs, the memory is stale: correct it with update_memory, or retire it with ' +
    'archive_memory. Do not work around it.',
  create_memory:
    'Write a new memory: `title`, `description`, `scope`, `type`, `body`, ' +
    '`provenance`. Call it once something durable, non-obvious, not repo-owned, and ' +
    `actionable is established rather than suspected: ${writeTriggerList}. For a root ` +
    'cause, store the signal that identifies it, not just the fix. Do not call it for ' +
    `${doNotStoreList}. Search first: a same-scope near-duplicate returns ` +
    '`duplicate_candidates` and writes nothing — prefer update_memory on the closest ' +
    'candidate, and repeat with `force_create` plus `force_create_reason` only when ' +
    'the knowledge is materially distinct. Scope is `projects` with resolved ids ' +
    'unless the knowledge holds independently of every project. `provenance.source` ' +
    'says where the knowledge came from and sets verification by default. ' +
    '`dropped_evidence` in the result means a reference was too fragile to keep (line ' +
    'numbers, temp paths, transcripts); the memory was still written.',
  update_memory:
    'Edit an existing memory in place by id: metadata `changes`, a body edit ' +
    '(`old_text`/`new_text` exact-match swap, or a full `body` replacement), ' +
    '`mark_verified` to record that you re-checked it and it still holds, or any ' +
    'combination. Prefer this over create_memory whenever an existing memory ' +
    'expresses substantially the same knowledge — two near-identical memories make ' +
    'retrieval return the weaker one half the time. Use it to correct a memory that ' +
    'code or current docs contradict, to add a project id once knowledge turns out to ' +
    'be shared, and to restore an archived memory (`changes.status: active`). Evidence ' +
    'and project ids merge by default; `replace: true` overwrites them. It cannot ' +
    'archive: that is archive_memory, because archiving always needs a reason.',
  archive_memory:
    'Retire a memory that no longer holds, with a required `reason`. Soft deletion: ' +
    'the file stays, the memory stays readable by id, and it drops out of normal ' +
    'search. Call it when the knowledge became false or irrelevant and editing cannot ' +
    'rescue it — a superseded decision, a quirk fixed at the root, a project that no ' +
    'longer exists. Do not call it to sharpen a memory that is still broadly true ' +
    '(update_memory), and never to tidy away memories you merely find unhelpful. ' +
    'Restore with update_memory setting `changes.status: active`.',
};
