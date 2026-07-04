// The answer_memory operation (§9.5): a convenience retrieval-and-synthesis tool
// that returns a compact, source-backed answer rather than a browsable result set.
//
// Synthesis is deliberately deterministic — no model call. The product property
// that matters is a unified, answer-shaped interface with source attribution, so
// the answer is assembled from the top memories' `## Summary` sections (falling
// back to the index excerpt) and the confidence is derived from lexical strength
// tempered by each source's own confidence metadata.

import { readFile } from 'node:fs/promises';

import { validate } from '../validation.js';
import { parseFrontmatter } from './frontmatter.js';
import { resolveMemoryPath } from './resolve.js';
import { answerMemoryInputSchema, type Confidence } from './schema.js';
import type { MemoryIndex, SearchHit } from './search-index.js';

export interface AnswerMemoryOptions {
  index: MemoryIndex;
  memoriesDir: string;
  maxLimit: number;
}

export interface AnswerSource {
  id: string;
  title: string;
  updated_at: string;
}

export interface AnswerMemoryResult {
  answer: string;
  sources: AnswerSource[];
  confidence: Confidence;
  caveat: string;
}

// Answers favour precision: default to a smaller top-k than search, still
// clamped to the configured maximum.
const ANSWER_DEFAULT_LIMIT = 3;

const STANDARD_CAVEAT =
  'This is memory-derived guidance; validate against current repository behavior and documentation.';
const NO_RESULTS_CAVEAT =
  'No relevant memory was found; this answer is not backed by stored memory.';
const NO_RESULTS_ANSWER = 'No relevant memory found for this question.';

// Lexical-score thresholds for the base confidence band before the source's own
// confidence metadata is applied as a ceiling.
const HIGH_SCORE = 0.6;
const MEDIUM_SCORE = 0.35;

export async function answerMemory(
  rawInput: unknown,
  options: AnswerMemoryOptions,
): Promise<AnswerMemoryResult> {
  const input = validate(answerMemoryInputSchema, rawInput);

  const limit = Math.min(input.limit ?? ANSWER_DEFAULT_LIMIT, options.maxLimit);
  const hits = options.index.search(input.question, { limit, project: input.project });

  if (hits.length === 0) {
    return {
      answer: NO_RESULTS_ANSWER,
      sources: [],
      confidence: 'low',
      caveat: NO_RESULTS_CAVEAT,
    };
  }

  const passages = await Promise.all(hits.map((hit) => passageFor(hit, options.memoriesDir)));
  const answer = passages.filter((p) => p.length > 0).join('\n\n');

  const sources =
    input.include_sources === false
      ? []
      : hits.map((hit) => ({ id: hit.id, title: hit.title, updated_at: hit.updated_at }));

  return {
    answer: answer.length > 0 ? answer : NO_RESULTS_ANSWER,
    sources,
    confidence: deriveConfidence(hits[0]!),
    caveat: STANDARD_CAVEAT,
  };
}

// Prefer the memory's authored `## Summary` (the canonical one-paragraph
// takeaway) over the truncated FTS excerpt. Fall back to the excerpt if the file
// is missing the section or cannot be read.
async function passageFor(hit: SearchHit, memoriesDir: string): Promise<string> {
  try {
    const path = await resolveMemoryPath(memoriesDir, hit.id);
    const { body } = parseFrontmatter(await readFile(path, 'utf8'));
    const summary = extractSummary(body);
    if (summary) return summary;
  } catch {
    // Fall through to the index excerpt below.
  }
  return hit.excerpt;
}

// Capture the text under a `## Summary` heading up to the next `## ` heading or
// end of body. Returns null when the section is absent or empty.
function extractSummary(body: string): string | null {
  const match = /##\s+Summary\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  const text = match?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

// Confidence is the base lexical band, capped by the top source's own confidence
// metadata: a strong keyword match on a memory the author marked low-confidence
// should not yield a high-confidence answer. Absent metadata imposes no ceiling.
function deriveConfidence(top: SearchHit): Confidence {
  const band: Confidence =
    top.score >= HIGH_SCORE ? 'high' : top.score >= MEDIUM_SCORE ? 'medium' : 'low';
  if (!top.confidence) return band;
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  return rank[top.confidence] < rank[band] ? top.confidence : band;
}
