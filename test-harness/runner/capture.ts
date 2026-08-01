// Capture-quality scorer (docs/harness-spec.md §5.2; memory-policy.md §3, §8).
//
// good_capture_rate counts should-capture reps where a memory was created/updated
// *and* passes a binary rubric — "a created-but-junk memory counts as a miss"
// (§5.1). This module finds the memories a session captured (new files, or seeded
// files it edited) and scores them against the five criteria. The rubric is a
// checklist first (string checks + front-matter validation, §5.2); an LLM judge is
// the escape hatch if the checklist proves too brittle, and is deliberately not
// built here.
//
// The two content-specific criteria (which insight, which layer) come from the
// scenario's capture_rubric; the three structural ones (a write happened, durable
// phrasing, a usable body) are the same for every capture.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { anyCaptureSuccess, memoryWasStored, type MementoCall } from './event-log.js';
import { compilePattern } from './pattern.js';
import { type CaptureRubric } from './scenario.js';

// The five binary criteria (§5.2). All must pass for a good capture.
export interface CaptureCriteria {
  stored: boolean; // C1: a create/update call succeeded (event log)
  insight: boolean; // C2: records the planted insight (string check)
  durable: boolean; // C3: durable phrasing, not a task log (§8)
  layer: boolean; // C4: correct layer/scope (§3 boundary)
  body: boolean; // C5: usable body — non-empty Summary, ~§7 template
}

export interface CaptureResult {
  attempted: boolean; // C1 alone: did the agent create/update anything durable?
  passed: boolean; // every criterion held for one captured memory
  criteria: CaptureCriteria; // the best candidate's criteria (all-false if none captured)
  memory_id: string | null; // which memory best satisfied the rubric (diagnostic)
}

export interface CapturedMemory {
  id: string | null;
  title: string;
  description: string;
  scope: string | null;
  body: string;
}

// Unambiguous task-log markers (§8 "do not create a memory for"): a memory that
// narrates the current change rather than stating durable knowledge. Kept narrow
// to avoid failing legitimate guidance; a scenario can add a stricter pattern via
// capture_rubric.task_log_anti_regex.
const TASK_LOG_RE =
  /\bTODO\b|\bthis (task|pr|commit|change|ticket)\b|\b(completed|finished) the\b/i;

/**
 * Score a should-capture rep. `stored` (C1) is a property of the session, not any
 * one memory; C2–C5 are evaluated per captured memory and the rep passes when C1
 * holds and some captured memory satisfies all of C2–C5. The reported criteria
 * are the highest-scoring candidate's, for diagnostics.
 */
export function scoreCapture(
  calls: MementoCall[],
  captured: CapturedMemory[],
  rubric: CaptureRubric,
): CaptureResult {
  const attempted = anyCaptureSuccess(calls);

  let best: { criteria: CaptureCriteria; id: string | null } | null = null;
  for (const memory of captured) {
    const criteria = evaluate(memory, memoryWasStored(calls, memory.id), rubric);
    if (!best || score(criteria) > score(best.criteria)) best = { criteria, id: memory.id };
    if (allPass(criteria)) break; // a fully-passing candidate is the best possible
  }

  const criteria = best?.criteria ?? {
    stored: attempted,
    insight: false,
    durable: false,
    layer: false,
    body: false,
  };
  return { attempted, passed: allPass(criteria), criteria, memory_id: best?.id ?? null };
}

function evaluate(memory: CapturedMemory, stored: boolean, rubric: CaptureRubric): CaptureCriteria {
  const haystack = `${memory.title}\n${memory.description}\n${memory.body}`;
  const heading = `${memory.title}\n${memory.description}`;

  const insight =
    compilePattern(rubric.insight_regex).test(haystack) &&
    !(rubric.insight_anti_regex && compilePattern(rubric.insight_anti_regex).test(haystack));

  const durable =
    !TASK_LOG_RE.test(heading) &&
    !(rubric.task_log_anti_regex && compilePattern(rubric.task_log_anti_regex).test(heading));

  const layer = rubric.expected_scope
    ? memory.scope !== null && rubric.expected_scope.includes(memory.scope)
    : memory.scope !== null;

  return { stored, insight, durable, layer, body: memory.body.trim().length > 0 };
}

/**
 * The memories a session captured: files in MEMENTO_HOME/memories that are new
 * (absent from the seeded baseline) or edited (present but changed). A seeded
 * distractor left untouched is excluded, so it can't be mistaken for a capture.
 */
export function findCapturedMemories(
  mementoHome: string,
  baseline: Map<string, string>,
): CapturedMemory[] {
  const dir = join(mementoHome, 'memories');
  if (!existsSync(dir)) return [];

  const captured: CapturedMemory[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const content = readFileSync(join(dir, name), 'utf8');
    const seeded = baseline.get(name);
    if (seeded !== undefined && seeded.trim() === content.trim()) continue; // untouched distractor
    captured.push(parseMemory(content));
  }
  return captured;
}

/**
 * The seeded corpus as filename → content, so findCapturedMemories can tell a
 * capture from an untouched distractor. Mirrors the sandbox's seedCorpus: every
 * .md in the corpus dir, plus the retrieve fact by basename.
 */
export function seededBaseline(
  harnessRoot: string,
  corpusRel: string,
  seededMemoryRel?: string,
): Map<string, string> {
  const baseline = new Map<string, string>();
  const corpusDir = join(harnessRoot, corpusRel);
  if (existsSync(corpusDir)) {
    for (const name of readdirSync(corpusDir)) {
      if (name.endsWith('.md')) baseline.set(name, readFileSync(join(corpusDir, name), 'utf8'));
    }
  }
  if (seededMemoryRel) {
    const factPath = join(harnessRoot, seededMemoryRel);
    if (existsSync(factPath)) baseline.set(basename(factPath), readFileSync(factPath, 'utf8'));
  }
  return baseline;
}

// --- front-matter + template helpers (local mirror of src/store, kept in-tree so
// the harness stays self-contained rather than importing across the rootDir) ---

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function parseMemory(raw: string): CapturedMemory {
  const match = FRONTMATTER_RE.exec(raw);
  const metadata = match ? parseMetadata(match[1] ?? '') : {};
  const body = match ? raw.slice(match[0].length).trim() : raw.trim();
  return {
    id: str(metadata.id),
    title: str(metadata.title) ?? '',
    description: str(metadata.description) ?? '',
    scope: scopeKind(metadata.scope),
    body,
  };
}

function parseMetadata(yamlBlock: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch {
    return {};
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function scopeKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return str((value as Record<string, unknown>).kind);
}

function score(criteria: CaptureCriteria): number {
  return Object.values(criteria).filter(Boolean).length;
}

function allPass(criteria: CaptureCriteria): boolean {
  return Object.values(criteria).every(Boolean);
}
