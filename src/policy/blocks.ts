// The canonical memory policy, as data.
//
// `memory-policy.md` is the source of truth for the rules; this module is the one
// place they become prose. `instructions.ts` and `descriptions.ts` assemble the
// three derived surfaces (policy §12) from these clauses, so the surfaces cannot
// drift from each other in vocabulary.
//
// To change a rule: edit `memory-policy.md`, bump its `policy_version`, mirror it
// in POLICY_VERSION, then edit the clauses here. `test/policy.test.ts` parses the
// policy document and fails while the two disagree — including when the document
// grows a trigger, a do-not-store row, or a type this file does not carry.
//
// Each list item carries a `probe`: the distinctive wording the tests look for in
// a rendered surface. That is how a surface proves it still covers a rule after
// compressing it, and how a surface that deliberately omits one declares it.

import { MEMORY_TYPES, type MemoryType } from '../store/memory-schema.js';

/** `policy_version` from the memory-policy.md front matter. Pinned by tests. */
export const POLICY_VERSION = '2.1.0';

/** A policy rule plus the wording that identifies it in a rendered surface. */
export interface PolicyClause<Key extends string> {
  key: Key;
  clause: string;
  probe: RegExp;
}

/** A clause that compresses several policy rules into one shorter phrasing. */
export interface CompactClause<Key extends string> {
  covers: readonly Key[];
  clause: string;
}

// --- §1 The boundary -------------------------------------------------------

export const PURPOSE =
  'Memento is a durable memory layer for context that helps coding work but that ' +
  'no single repository owns: decisions and the alternatives they rejected, ' +
  'product and customer constraints, how projects and services relate, standing ' +
  'preferences, and environment or vendor behaviour learned the hard way.';

export const PURPOSE_COMPACT =
  'Memento stores durable, non-obvious context that no repository owns.';

export const REPO_OWNS =
  'Each repository still owns its own truth — build steps, architecture, API ' +
  'contracts, implementation detail.';

export const CODE_WINS =
  'When code or current repository documentation disagrees with a memory, code ' +
  'and docs win: the memory is wrong and should be updated or archived, not ' +
  'worked around.';

export const CODE_WINS_COMPACT =
  'treat code and current repo docs as more authoritative than memory';

// --- §2 What belongs -------------------------------------------------------

export type EligibilityKey = 'durable' | 'non_obvious' | 'not_repo_owned' | 'actionable';

export const ELIGIBILITY_TESTS: readonly PolicyClause<EligibilityKey>[] = [
  { key: 'durable', clause: 'it is still true weeks from now', probe: /weeks from now/ },
  {
    key: 'non_obvious',
    clause: 'an agent reading the repository would not arrive at it',
    probe: /would not arrive at it/,
  },
  {
    key: 'not_repo_owned',
    clause: 'no repository is its natural home',
    probe: /natural home/,
  },
  {
    key: 'actionable',
    clause: 'it would change a plan or a diagnosis',
    probe: /change a plan or a diagnosis/,
  },
];

// --- §3 What does not belong ----------------------------------------------

export type DoNotStoreKey =
  'secrets' | 'transient' | 'repo_facts' | 'copied_docs' | 'speculation' | 'scratch' | 'duplicate';

export const DO_NOT_STORE: readonly PolicyClause<DoNotStoreKey>[] = [
  { key: 'secrets', clause: 'secrets, tokens, keys, or customer data', probe: /secrets/ },
  { key: 'transient', clause: 'task status or progress notes', probe: /task status/ },
  {
    key: 'repo_facts',
    clause: 'facts derivable from code, config, tests, or maintained docs',
    probe: /facts derivable from/,
  },
  {
    key: 'copied_docs',
    clause: 'copied third-party documentation (link it as evidence instead)',
    probe: /copied[- ](?:third-party )?documentation/,
  },
  {
    key: 'speculation',
    clause: 'speculation presented as fact',
    probe: /speculation/,
  },
  {
    key: 'scratch',
    clause: 'scratch notes, TODOs, or plans for the change in flight',
    probe: /scratch notes/,
  },
  {
    // Covered by the §11 dedupe rule wherever a surface has room for only one of
    // the two: "extend the near-match" says the same thing operationally.
    key: 'duplicate',
    clause: 'knowledge an existing memory already expresses',
    probe: /(?:existing memory already expresses|near-match)/,
  },
];

// The fragment keeps the three rules an agent is most likely to break; the rest
// reach it through the server instructions and the `create_memory` description.
export const DO_NOT_STORE_COMPACT: readonly CompactClause<DoNotStoreKey>[] = [
  { covers: ['transient'], clause: 'task status' },
  { covers: ['secrets'], clause: 'secrets' },
  { covers: ['repo_facts'], clause: 'facts derivable from the repository' },
];

export const FRAGMENT_OMITTED_DO_NOT_STORE: readonly DoNotStoreKey[] = [
  'copied_docs',
  'speculation',
  'scratch',
];

// --- §4 When to search -----------------------------------------------------

export type SearchTriggerKey =
  | 'debugging'
  | 'multi_project'
  | 'rationale'
  | 'product'
  | 'vendor'
  | 'planning'
  | 'environment'
  | 'past_work';

export const SEARCH_TRIGGERS: readonly PolicyClause<SearchTriggerKey>[] = [
  {
    key: 'debugging',
    clause: 'debugging anything non-obvious, recurring, or familiar-feeling',
    probe: /debugging (?:anything|something) non-obvious/,
  },
  {
    key: 'multi_project',
    clause: 'work touching more than one repository or project',
    probe: /more than one (?:repository or )?project/,
  },
  {
    key: 'rationale',
    clause: 'a decision that may already have a rationale',
    probe: /may already have a rationale/,
  },
  {
    key: 'product',
    clause: 'a change a product or customer constraint might govern',
    probe: /product (?:or customer )?constraint/,
  },
  {
    key: 'vendor',
    clause: 'work involving a third-party service, vendor, or external tool',
    probe: /(?:third-party service|vendor)/,
  },
  {
    key: 'planning',
    clause: 'planning, architecture, migration, or testing strategy',
    probe: /planning(?:,| or architecture)/,
  },
  {
    key: 'environment',
    clause: 'an environment, tool, or workflow behaving unexpectedly',
    probe: /environment,? (?:tool|tooling)/,
  },
  {
    key: 'past_work',
    clause: 'a reference to past work, a past incident, or "we decided"',
    probe: /past work/,
  },
];

// The fragment has room for one sentence of triggers, so it compresses §4. The
// omissions are pinned in `FRAGMENT_OMITTED_SEARCH_TRIGGERS` — the full list
// still reaches the agent through the server instructions and the
// `search_memories` description.
export const SEARCH_TRIGGERS_COMPACT: readonly CompactClause<SearchTriggerKey>[] = [
  { covers: ['debugging'], clause: 'debugging something non-obvious or recurring' },
  { covers: ['multi_project'], clause: 'work spanning more than one project' },
  { covers: ['planning'], clause: 'planning or architecture' },
  { covers: ['rationale'], clause: 'a decision that may already have a rationale' },
  {
    // Not "or a standing preference": §4 has no preference trigger, and a surface
    // may compress the policy, never extend it.
    covers: ['product', 'vendor'],
    clause: 'work a product constraint or a third-party service might govern',
  },
];

export const FRAGMENT_OMITTED_SEARCH_TRIGGERS: readonly SearchTriggerKey[] = [
  'environment',
  'past_work',
];

export const SEARCH_DISCIPLINE =
  'Run one targeted search, read the top one or two results, then stop — no ' +
  'results is a normal answer, not a reason to search again differently.';

export const SEARCH_ANTI_TRIGGERS =
  'Do not search for simple self-contained edits or anything answerable from the ' +
  'file in hand.';

// --- §5 When to create or update ------------------------------------------

export type WriteTriggerKey =
  'root_cause' | 'rationale' | 'relationship' | 'preference' | 'contradiction' | 'quirk';

export const WRITE_TRIGGERS: readonly PolicyClause<WriteTriggerKey>[] = [
  {
    key: 'root_cause',
    // No em dash: this clause renders inside a list that already sits behind one.
    clause: 'a reusable root cause, with the signal that identifies it rather than just the fix',
    probe: /reusable root cause/,
  },
  {
    key: 'rationale',
    clause: 'why something is the way it is, or why an alternative was rejected',
    probe: /alternative was rejected/,
  },
  {
    key: 'relationship',
    clause: 'a relationship between projects, systems, or services',
    probe: /(?:relationship between projects|projects depend on each other)/,
  },
  {
    key: 'preference',
    clause: 'a durable user preference or working agreement',
    probe: /durable (?:user )?preference/,
  },
  {
    key: 'contradiction',
    clause: 'a decision a future agent could otherwise unknowingly contradict',
    probe: /unknowingly contradict/,
  },
  {
    key: 'quirk',
    clause: 'an environment or workflow quirk that cost real time and will recur',
    probe: /quirk that (?:cost|will)/,
  },
];

export const WRITE_TRIGGERS_COMPACT: readonly CompactClause<WriteTriggerKey>[] = [
  { covers: ['root_cause'], clause: 'a reusable root cause' },
  { covers: ['rationale'], clause: 'why an alternative was rejected' },
  { covers: ['relationship'], clause: 'how two projects depend on each other' },
  { covers: ['preference'], clause: 'a durable preference' },
  { covers: ['quirk'], clause: 'an environment quirk that cost real time' },
];

export const FRAGMENT_OMITTED_WRITE_TRIGGERS: readonly WriteTriggerKey[] = ['contradiction'];

export const ESTABLISHED = 'once you have established, not merely suspected:';

// --- §6 Proactivity --------------------------------------------------------

export const PROACTIVITY = 'Use it unprompted.';

// --- §7 Types --------------------------------------------------------------

// The six real types, in enum order. `other` is deliberately absent: it is
// described by ROUTING instead, so nothing advertises it as a normal choice.
export const TYPE_LINES: Record<Exclude<MemoryType, 'other'>, string> = {
  debugging_pattern:
    'a reusable failure mode: symptom, root cause, and the signal that identifies it',
  cross_project_context: 'how projects, repositories, or systems relate',
  decision_history: 'a decision, its rationale, and the alternatives rejected',
  product_rationale: 'a product or customer constraint that explains a technical shape',
  preference: 'how the user wants work done',
  environment_workflow_quirk: 'machine, tooling, vendor, or workflow behaviour that surprises',
};

/** The six type names in enum order — the fragment's whole taxonomy surface. */
export const TYPE_NAMES = MEMORY_TYPES.filter((type) => type !== 'other');

export const ROUTING =
  'Third-party behaviour, testing pitfalls, and incident lessons route into those ' +
  'six; `other` is discouraged and needs a justification in the body.';

// --- §8 Scope --------------------------------------------------------------

export const SCOPE_RULE =
  'Scope is `projects` with one id per project the knowledge genuinely concerns; ' +
  '`global` is rare, for knowledge true independently of every project.';

// --- §8.1 Resolving projects ----------------------------------------------

export const PROJECT_RESOLUTION =
  'Resolve a working directory, git remote, or repository name to a project id ' +
  'with resolve_project before any project-scoped search or write; ids are opaque, ' +
  'and a path, name, or alias is never accepted in their place. Candidates mean ' +
  'reuse one, not create a second project; a moved checkout, a new remote, or a ' +
  'rename is an update_project.';

// --- §11 Duplicates --------------------------------------------------------

export const DUPLICATES =
  'Search before writing, and extend a same-scope near-match with update_memory ' +
  'rather than sitting a second memory beside it.';

export const DUPLICATES_COMPACT =
  'Extend a near-match with `update_memory` rather than storing a second version ' + 'of it';
