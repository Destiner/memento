// Drift guards for the derived instruction surfaces (memory-policy.md §12).
//
// Two directions of drift are checked. Against the policy *document*: its version,
// its type table, and the size of its three rule lists, so a rule added to
// `memory-policy.md` fails the suite until `blocks.ts` carries it. Against the
// *surfaces*: every rule must be recognisable in the server instructions, and in
// the fragment unless the compression is declared. Wording is not compared
// verbatim — the surfaces deliberately differ in verbosity — so each rule carries
// a probe describing what it must still say.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  DO_NOT_STORE,
  DO_NOT_STORE_COMPACT,
  ELIGIBILITY_TESTS,
  FRAGMENT_OMITTED_DO_NOT_STORE,
  FRAGMENT_OMITTED_SEARCH_TRIGGERS,
  FRAGMENT_OMITTED_WRITE_TRIGGERS,
  POLICY_VERSION,
  SEARCH_TRIGGERS,
  SEARCH_TRIGGERS_COMPACT,
  TYPE_LINES,
  TYPE_NAMES,
  WRITE_TRIGGERS,
  WRITE_TRIGGERS_COMPACT,
} from '../src/policy/blocks.js';
import { AGENT_FRAGMENT, SERVER_INSTRUCTIONS } from '../src/policy/instructions.js';
import { plainDescriptions, triggerListDescriptions } from '../src/policy/descriptions.js';
import { MEMORY_TYPES } from '../src/store/memory-schema.js';

const POLICY_PATH = join(import.meta.dirname, '..', 'memory-policy.md');
const policy = readFileSync(POLICY_PATH, 'utf8');

// The fragment is hard-wrapped for pasting, so a probe would otherwise miss any
// phrase a line break falls inside.
const fragmentText = AGENT_FRAGMENT.replace(/\s+/g, ' ');

/** The body of a policy section, from its heading to the next same-or-higher one. */
function section(heading: string): string {
  const start = policy.indexOf(heading);
  expect(start, `${heading} missing from memory-policy.md`).toBeGreaterThan(-1);
  const rest = policy.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

const TOOL_NAMES = Object.keys(triggerListDescriptions) as (keyof typeof triggerListDescriptions)[];

// Every surface in one bag, for the vocabulary checks that apply to all of them.
const ALL_SURFACES: Record<string, string> = {
  fragment: AGENT_FRAGMENT,
  'server instructions': SERVER_INSTRUCTIONS,
  ...Object.fromEntries(TOOL_NAMES.map((tool) => [`plain:${tool}`, plainDescriptions[tool]])),
  ...Object.fromEntries(
    TOOL_NAMES.map((tool) => [`triggerList:${tool}`, triggerListDescriptions[tool]]),
  ),
};

describe('the policy document and blocks.ts agree', () => {
  test('POLICY_VERSION mirrors the front matter', () => {
    expect(policy).toMatch(new RegExp(`^policy_version: ${POLICY_VERSION}$`, 'm'));
  });

  test('the §7 type table is exactly the schema enum, in order', () => {
    const table = section('## 7. Types');
    const listed = [...table.matchAll(/^\| `([a-z_]+)`/gm)].map((match) => match[1]);
    expect(listed).toEqual([...MEMORY_TYPES]);
    // `other` is described by ROUTING rather than advertised as a type line.
    expect(Object.keys(TYPE_LINES)).toEqual([...TYPE_NAMES]);
    expect(TYPE_NAMES).not.toContain('other');
  });

  test('§4 carries no trigger blocks.ts is missing', () => {
    const bullets = [...section('## 4. When to search').matchAll(/^- /gm)];
    expect(bullets).toHaveLength(SEARCH_TRIGGERS.length);
  });

  test('§5 carries no write trigger blocks.ts is missing', () => {
    const bullets = [...section('## 5. When to create or update').matchAll(/^- /gm)];
    expect(bullets).toHaveLength(WRITE_TRIGGERS.length);
  });

  test('the §3 table carries no do-not-store rule blocks.ts is missing', () => {
    const rows = [...section('## 3. What does not belong').matchAll(/^\| (?!-|Not this)/gm)];
    expect(rows).toHaveLength(DO_NOT_STORE.length);
  });

  test('§2 carries no eligibility test blocks.ts is missing', () => {
    const numbered = [...section('## 2. What belongs in memory').matchAll(/^\d+\. /gm)];
    expect(numbered).toHaveLength(ELIGIBILITY_TESTS.length);
  });

  test('§8.1 exists, since the surfaces state project resolution as policy', () => {
    expect(section('### 8.1 Resolving projects')).toMatch(/never invent one/);
  });

  test('§12 points at the modules that actually generate the surfaces', () => {
    const derived = section('## 12. Derived surfaces');
    expect(derived).toContain('src/policy/blocks.ts');
    expect(derived).toContain('src/policy/instructions.ts');
    expect(derived).toContain('src/policy/descriptions.ts');
  });
});

describe('the server instructions carry the whole policy', () => {
  test.each(SEARCH_TRIGGERS)('search trigger: $key', ({ probe }) => {
    expect(SERVER_INSTRUCTIONS).toMatch(probe);
  });

  test.each(WRITE_TRIGGERS)('write trigger: $key', ({ probe }) => {
    expect(SERVER_INSTRUCTIONS).toMatch(probe);
  });

  test.each(DO_NOT_STORE)('do-not-store: $key', ({ probe }) => {
    expect(SERVER_INSTRUCTIONS).toMatch(probe);
  });

  test.each(ELIGIBILITY_TESTS)('eligibility: $key', ({ probe }) => {
    expect(SERVER_INSTRUCTIONS).toMatch(probe);
  });

  test('states proactivity, the boundary, and project resolution', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/unprompted/);
    expect(SERVER_INSTRUCTIONS).toMatch(/code and docs win/);
    expect(SERVER_INSTRUCTIONS).toMatch(/resolve_project before any project-scoped/);
    expect(SERVER_INSTRUCTIONS).toMatch(/`global` is rare/);
  });

  test('defines every type, and nudges nothing toward `other`', () => {
    for (const [type, holds] of Object.entries(TYPE_LINES)) {
      expect(SERVER_INSTRUCTIONS).toContain(`\`${type}\` — ${holds}.`);
    }
    expect(SERVER_INSTRUCTIONS).toMatch(/`other` is discouraged/);
  });

  test('stays five paragraphs and under budget', () => {
    expect(SERVER_INSTRUCTIONS.split('\n\n')).toHaveLength(5);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(3600);
  });
});

describe('the fragment compresses the policy without dropping it silently', () => {
  const covered = <Key extends string>(clauses: readonly { covers: readonly Key[] }[]): Key[] =>
    clauses.flatMap((clause) => [...clause.covers]);

  test('every search trigger is either compressed into the fragment or declared omitted', () => {
    const accounted = new Set([
      ...covered(SEARCH_TRIGGERS_COMPACT),
      ...FRAGMENT_OMITTED_SEARCH_TRIGGERS,
    ]);
    expect([...accounted].sort()).toEqual(SEARCH_TRIGGERS.map((t) => t.key).sort());
  });

  test('every write trigger is either compressed into the fragment or declared omitted', () => {
    const accounted = new Set([
      ...covered(WRITE_TRIGGERS_COMPACT),
      ...FRAGMENT_OMITTED_WRITE_TRIGGERS,
    ]);
    expect([...accounted].sort()).toEqual(WRITE_TRIGGERS.map((t) => t.key).sort());
  });

  test('every do-not-store rule is either compressed into the fragment or declared omitted', () => {
    const accounted = new Set([
      ...covered(DO_NOT_STORE_COMPACT),
      ...FRAGMENT_OMITTED_DO_NOT_STORE,
      // Stated as the dedupe recovery path instead of a do-not-store line.
      'duplicate' as const,
    ]);
    expect([...accounted].sort()).toEqual(DO_NOT_STORE.map((rule) => rule.key).sort());
  });

  test('the rules it claims to keep are actually recognisable in the text', () => {
    const kept = [
      ...SEARCH_TRIGGERS.filter((t) => !FRAGMENT_OMITTED_SEARCH_TRIGGERS.includes(t.key)),
      ...WRITE_TRIGGERS.filter((t) => !FRAGMENT_OMITTED_WRITE_TRIGGERS.includes(t.key)),
      ...DO_NOT_STORE.filter((rule) => !FRAGMENT_OMITTED_DO_NOT_STORE.includes(rule.key)),
    ];
    for (const rule of kept) {
      expect(fragmentText, `fragment lost ${rule.key}`).toMatch(rule.probe);
    }
  });

  test('names every type without defining any of them', () => {
    for (const type of TYPE_NAMES) {
      expect(AGENT_FRAGMENT).toContain(`\`${type}\``);
    }
    for (const holds of Object.values(TYPE_LINES)) {
      expect(fragmentText).not.toContain(holds);
    }
    expect(fragmentText).not.toMatch(/`other`/);
  });

  test('is a pasteable two-paragraph section, wrapped and under budget', () => {
    expect(AGENT_FRAGMENT.startsWith('## Memory (memento)\n')).toBe(true);
    const paragraphs = AGENT_FRAGMENT.trim().split('\n\n');
    expect(paragraphs).toHaveLength(3); // heading + two paragraphs
    expect(AGENT_FRAGMENT.length).toBeLessThanOrEqual(1200);
    for (const line of AGENT_FRAGMENT.split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  test('says unprompted twice: reading and writing are separate habits', () => {
    expect(AGENT_FRAGMENT.match(/unprompted/g)).toHaveLength(2);
  });
});

describe('tool descriptions are locally actionable', () => {
  test('the trigger-list set names each tool prerequisite and recovery path', () => {
    const { triggerListDescriptions: set } = { triggerListDescriptions };
    expect(set.resolve_project).toMatch(/before every project-scoped search or write/);
    expect(set.resolve_project).toMatch(/not_found` — only then call create_project/);
    expect(set.create_project).toMatch(/only after resolve_project returned `not_found`/);
    expect(set.create_project).toMatch(/duplicate_candidates` nothing was written/);
    expect(set.update_project).toMatch(/id never changes/);
    expect(set.search_memories).toMatch(/Scope is required/);
    expect(set.search_memories).toMatch(/call get_memory on a promising one/);
    expect(set.get_memory).toMatch(/ids come from search_memories/);
    expect(set.create_memory).toMatch(/Search first/);
    expect(set.create_memory).toMatch(/force_create_reason/);
    expect(set.update_memory).toMatch(/Prefer this over create_memory/);
    expect(set.archive_memory).toMatch(/required `reason`/);
  });

  test('every trigger-list description says when not to call the tool', () => {
    for (const tool of TOOL_NAMES) {
      expect(triggerListDescriptions[tool], tool).toMatch(/\b(?:not|never|cannot)\b/i);
    }
  });

  test('search_memories carries the full §4 trigger list; create_memory the §3 rules', () => {
    for (const { probe, key } of SEARCH_TRIGGERS) {
      expect(triggerListDescriptions.search_memories, key).toMatch(probe);
    }
    for (const rule of DO_NOT_STORE) {
      if (rule.key === 'duplicate') continue;
      expect(triggerListDescriptions.create_memory, rule.key).toMatch(rule.probe);
    }
  });

  test('type meanings live in the server instructions only', () => {
    for (const holds of Object.values(TYPE_LINES)) {
      for (const tool of TOOL_NAMES) {
        expect(triggerListDescriptions[tool]).not.toContain(holds);
      }
    }
  });

  test('the plain floor stays neutral: no triggers, no policy, no proactivity', () => {
    for (const tool of TOOL_NAMES) {
      const description = plainDescriptions[tool];
      expect(description, tool).not.toMatch(/unprompted|proactiv/i);
      for (const { probe, key } of [...SEARCH_TRIGGERS, ...WRITE_TRIGGERS]) {
        expect(description, `${tool} leaked ${key}`).not.toMatch(probe);
      }
    }
  });

  test('every description stays under budget', () => {
    for (const tool of TOOL_NAMES) {
      expect(triggerListDescriptions[tool].length, tool).toBeLessThanOrEqual(1500);
      expect(plainDescriptions[tool].length, tool).toBeLessThanOrEqual(200);
    }
  });
});

describe('no surface speaks V1', () => {
  // Tool names, enums, and fields V2 removed. A surviving mention would send an
  // agent at a tool that no longer exists or a field the schema rejects.
  const RETIRED = [
    /\bsearch_memory\b/,
    /\bread_memory\b/,
    /\banswer_memory\b/,
    /\bconfidence\b/,
    /\bimportance\b/,
    /\bentities\b/,
    /\btags\b/,
    /\bsupersedes\b/,
    /\btriage\b/,
    /\bincident_learning\b/,
    /\bworking_agreement\b/,
    /\bproduct_context\b/,
    /\bcross_project\b/,
    /\bexternal_tooling\b/,
    /\bpersonal\b/,
  ];

  test.each(Object.entries(ALL_SURFACES))('%s', (_name, surface) => {
    for (const retired of RETIRED) {
      expect(surface).not.toMatch(retired);
    }
  });
});
