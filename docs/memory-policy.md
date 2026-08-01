---
policy_version: 2.1.0
updated: 2026-08-01
---

# Memento Memory Policy

This document is the single source of truth for what Memento stores, when agents
reach for it, and what vocabulary everything uses. Every instruction surface —
MCP server instructions, tool descriptions, and the shipped AGENTS.md snippet —
is derived from this file and must not restate policy independently (§12).

Changing §2-§10 requires a `policy_version` bump, regeneration of all derived
surfaces, and a package-version bump (the change is measurement-relevant; see
the harness rules in AGENTS.md).

## 1. The boundary

Memento holds context that helps coding work but that no single repository owns.
The repository owns its own formal truth: build steps, architecture it controls,
API contracts, deployment, implementation detail, operating procedure.

When code or current repository documentation disagrees with a memory, code and
docs win. The memory is then wrong and should be updated or archived, not worked
around.

## 2. What belongs in memory

All four must hold. If any fails, do not store it.

1. **Durable** — still true and still useful weeks from now.
2. **Non-obvious** — a competent agent reading the repo would not arrive at it.
3. **Not repo-owned** — no single repository is its natural home, or no repo
   could state it (product rationale, vendor behaviour, personal preference).
4. **Actionable** — it would change a plan, a diagnosis, or a decision.

## 3. What does not belong

| Not this                                                     | Where it goes instead                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Transient progress, task status, "worked on X"               | Nowhere. The transcript suffices.                                                     |
| Ordinary code facts, file layout, API contracts, build commands | Repository docs                                                                     |
| Secrets, tokens, keys, customer data                         | Never stored. Secret manager.                                                          |
| Copied third-party documentation                             | Link it as `provenance.evidence`                                                       |
| Speculative guesses presented as fact                        | Not stored; or stored as `inferred`/`unverified` and labelled as such in the body       |
| Scratch notes, TODOs, plans for the change in flight         | Issue tracker or the branch                                                            |
| Knowledge an existing memory already expresses               | `update_memory` on that memory                                                         |

## 4. When to search

Run one targeted search, unprompted, before:

- debugging anything non-obvious, recurring, or familiar-feeling
- work that touches more than one repository or project
- a decision that may already have a rationale ("why is it built this way?")
- a change a product or customer constraint might govern
- work involving a third-party service, vendor, or external tool
- planning, architecture, migration, or testing strategy
- an environment, tooling, or workflow behaving unexpectedly
- responding to a reference to past work, a past incident, or "we decided"

Do not search for: simple self-contained edits, formatting, single-file changes
with no cross-cutting concern, or anything answerable from the file in hand.

Discipline: one search, read the top one or two results, stop. A search that
returns nothing is a normal outcome, not a reason to search again differently.

This list is deliberately not a mirror of the type enum in §7. It describes when
memory is likely to help, which is a different question from how knowledge is
filed. Third-party services and testing strategy appear here as triggers without
having types of their own; §7.1 says where such memories land.

## 5. When to create or update

Create or update, unprompted, after learning:

- a reusable root cause — the cause and the signal that identifies it, not the fix
- why something is the way it is, or why an alternative was rejected
- a relationship between projects, systems, or services
- a durable user preference or working agreement
- a decision a future agent could otherwise unknowingly contradict
- an environment or workflow quirk that cost real time and will recur

Always search before creating. Prefer `update_memory` when an existing memory
expresses substantially the same knowledge. Never pass the dedupe gate by
reflex — `force_create` requires a reason.

## 6. Proactivity

Do not wait to be asked. Memory use is a normal part of doing the work well, at
the moments listed in §4 and §5. Equally: do not narrate it, and do not search
or write outside those moments to look diligent.

## 7. Types

Exactly one type per memory.

| Type                         | Holds                                                              | Example                                                                                                | Not this                             |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `debugging_pattern`          | A reusable failure mode: symptom, root cause, identifying signal   | "Webhook retries look like duplicate deliveries when the idempotency key is derived from the payload hash" | A one-off fix; a stack trace         |
| `cross_project_context`      | How projects, repos, or systems relate                             | "`web` and `billing-api` jointly implement onboarding; changing either needs the other checked"          | Facts about one repo                 |
| `decision_history`           | A decision, its rationale, and rejected alternatives               | "Chose polling over webhooks in 2026-03; the vendor cannot sign payloads"                                | A plan not yet decided               |
| `product_rationale`          | Product or customer constraint explaining a technical shape        | "The legacy export stays because two enterprise accounts script against it"                             | Feature descriptions                 |
| `preference`                 | How the user wants work done                                       | "Conventional commits, minimal bodies"                                                                  | One-off instructions for one task    |
| `environment_workflow_quirk` | Local machine, tooling, external service, or workflow behaviour that surprises | "Headless `codex exec` cancels MCP calls without `--dangerously-bypass-approvals-and-sandbox`"  | Documented, expected tool usage      |
| `other`                      | Discouraged. Only when nothing above fits.                         | —                                                                                                       | Anything the six above cover         |

`other` requires a justification in the body. A rising `other` rate is a signal
the taxonomy needs a new type, not that agents are using it correctly.

### 7.1 Routing cases the enum does not name

The enum is intentionally small. These recurring shapes have no type of their
own and must not become `other`:

- **Third-party service or vendor behaviour** → `environment_workflow_quirk` when
  it is surprising behaviour to design around ("the email provider delays
  webhook events under peak load; arrival time is not a freshness signal");
  `debugging_pattern` when it is a failure mode with an identifying signal;
  `cross_project_context` when the point is that several projects depend on it.
- **Testing pitfalls and approaches** → `debugging_pattern` for a flake or trap
  with a root cause ("sandbox integration tests need a fixed clock or the TTL
  assertions flake"); `decision_history` when a testing approach was chosen over
  an alternative; `preference` when it is how the user wants testing done.
- **Incident learnings** → `debugging_pattern`. Store the reusable lesson, not
  the incident narrative.
- **Plans** → usually not memory-worthy. If a plan hardened into a commitment,
  it is `decision_history`; otherwise it belongs in an issue tracker.

## 8. Scope

- `projects` — the default. `project_ids[]` must be non-empty and every id must
  resolve to a registered project. Multiple ids for genuinely shared knowledge.
- `global` — only when true independently of every project.

`global` is rare and should be justified. The intended cases are `preference`
memories and universal working agreements; a vendor quirk that happens to affect
several projects is `projects` with several ids, not `global`. When unsure,
choose `projects`.

### 8.1 Resolving projects

Project ids are opaque and internal. Before any project-scoped search or write,
resolve the working directory, git remote, or repository name to a registered
project id. Never substitute a path, repository name, alias, or git remote for an
id, and never invent one.

- Candidates rather than an exact match mean reuse one, not create a second. Two
  projects for one codebase split its memories in half.
- A moved checkout, a new remote, or a rename updates the existing project. The
  id — and every memory scoped to it — survives.
- Create a project only when resolution found nothing.

## 9. Provenance

**`source`** — where the knowledge came from:

- `user_stated` — the user said it
- `agent_observed` — the agent saw it happen (tool output, logs, a failing test)
- `external_reference` — documented externally; put the reference in `evidence`
- `inferred` — deduced, not observed. The weakest source; say so in the body.

**`verification`** — how well it is established:

- `unverified` — asserted, not checked
- `observed_once` — seen happen a single time
- `user_confirmed` — the user explicitly confirmed it
- `source_confirmed` — backed by an authoritative source or a reproducible check

Defaults: `user_stated` → `user_confirmed`. `agent_observed` → `observed_once`.
`external_reference` → `source_confirmed`. `inferred` → `unverified`.

**`evidence[]`** — durable references only: commit SHAs, permanent URLs, issue
ids, stable paths. Never session transcripts, temp files, or line numbers.

**`last_verified_at`** — set when a memory is re-checked and still holds.

## 10. Status

`active` or `archived`. Archive rather than delete, always with a reason.
Restoration is an `update_memory` back to `active`. Agents never hard-delete.

## 11. Duplicates

The store is dedupe-gated at write time, but the policy is the agent's: search
first, and treat a same-scope near-match as a memory to extend rather than a
neighbour to sit beside. Two memories saying almost the same thing are worse
than one, because retrieval then returns the weaker one half the time.

## 12. Derived surfaces

Every surface is assembled from `src/policy/blocks.ts`, which holds these rules
as data:

- `src/policy/instructions.ts` — MCP server instructions and the shipped
  AGENTS.md / CLAUDE.md fragment (print either with `memento instructions`)
- `src/policy/descriptions.ts` — tool descriptions

Terminology must match this file verbatim: type names, the §4 trigger list, and
the §3 do-not-store rules. When §2-§10 changes, edit this document first, bump
`policy_version`, then mirror it in `POLICY_VERSION` and update the clauses in
`blocks.ts`; `test/policy.test.ts` parses this file and fails while the two
disagree. A surface may compress the rules, never contradict or extend them.

## Appendix: History

- `2.1.0` (2026-08-01) — added §8.1 (resolving projects) so the derived surfaces
  can state the prerequisite without inventing policy, and §12 now points at
  `src/policy/`. No change to what is stored or when.
- `2.0.0` (2026-07-31) — initial freeze for V2. Six types plus `other`; two
  scopes; provenance replaces `confidence`/`source_kind`. `third_party_service`
  and `testing_strategy` were considered and rejected as overfitting; §7.1
  routes them instead.
