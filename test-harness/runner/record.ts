// The per-rep results record (harness-spec §8.2). One JSON object per rep is
// appended to results/results.jsonl; scores are always recomputed from this log,
// never stored as the only copy, so a changed λ or a new diagnostic re-scores all
// history for free. This module builds the record and computes config_hash — a
// hash of the config dir's artifacts, so silent config drift is detectable.
//
// The `scored` fields (memento_calls, utility_pass, task_success, capture) come
// from the scorers (§11.4); the lifecycle fills them before appending. Until the
// scorers land, reps record UNSCORED placeholders and the session diagnostics.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type Cell } from './plan.js';
import { type ScenarioClass } from './scenario.js';

export type RepStatus = 'ok' | 'invalid' | 'halted';

// Raw per-rep facts the report re-scores from (§8.2 "raw"). Scored fields are
// nullable so an unscored (or invalid) rep is still a well-formed record.
export interface RawFacts {
  memento_calls: unknown[] | null;
  corpus_file_access?: boolean;
  utility_pass: boolean | null;
  task_success: boolean | null;
  capture: unknown | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_s: number | null;
  turns: number | null;
}

export interface SessionFacts {
  cost_usd: number | null;
  // Transcript contains the private memento-home path: the agent reached the
  // corpus as files rather than through MCP (a real access path for a
  // file-first store, but a distinct channel; codex transcripts carry command
  // output, claude-code result-only transcripts mostly can't show it).
  corpus_file_access?: boolean;
  duration_s: number | null;
  turns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface ScoredFacts {
  memento_calls: unknown[] | null;
  utility_pass: boolean | null;
  task_success: boolean | null;
  capture: unknown | null;
}

/** Placeholder scores for a rep that has not been through the scorers (§11.4). */
export const UNSCORED: ScoredFacts = {
  memento_calls: null,
  utility_pass: null,
  task_success: null,
  capture: null,
};

export interface ResultRecord {
  run: string;
  timestamp: string;
  config: string;
  config_hash: string;
  scenario: string;
  scenario_version: number;
  // The scenario's class, persisted so the report never has to reconstruct it from
  // on-disk scenario dirs — a renamed or retired scenario would otherwise drop out
  // of its rate denominator silently (§5, §8.2). Optional: records written before
  // this field lack it, and the report falls back to disk/inference for those.
  scenario_class?: ScenarioClass;
  rep: number;
  model: string;
  cc_version: string;
  memento_version: string;
  env: string;
  status: RepStatus;
  raw: RawFacts;
  transcript_path: string;
  // Session diff saved beside the transcript, or null when unavailable (invalid
  // rep, halted cell, or a diff failure). Lets utility verdicts be audited after
  // the sandbox is gone — screening-2's false negatives were unprovable without it.
  // Optional so records written before this field existed still parse.
  diff_path?: string | null;
  // Which coding agent ran the rep. Optional for pre-codex records, which are all
  // claude-code; readers treat absence as 'claude-code'. For non-claude-code
  // records, cc_version carries that harness's version (name kept for
  // compatibility with the pre-codex log).
  harness?: string;
}

export interface BuildRecordOptions {
  run: string;
  timestamp: string;
  model: string;
  ccVersion: string;
  mementoVersion: string;
  env: string;
  cell: Cell;
  configHash: string;
  status: RepStatus;
  session: SessionFacts;
  scored: ScoredFacts;
  transcriptPath: string;
  diffPath: string | null;
  harness: string;
}

export function buildRecord(opts: BuildRecordOptions): ResultRecord {
  return {
    run: opts.run,
    timestamp: opts.timestamp,
    config: opts.cell.config.name,
    config_hash: opts.configHash,
    scenario: opts.cell.scenario.id,
    scenario_version: opts.cell.scenario.version,
    scenario_class: opts.cell.scenario.class,
    rep: opts.cell.rep,
    model: opts.model,
    cc_version: opts.ccVersion,
    memento_version: opts.mementoVersion,
    env: opts.env,
    status: opts.status,
    raw: {
      memento_calls: opts.scored.memento_calls,
      utility_pass: opts.scored.utility_pass,
      task_success: opts.scored.task_success,
      capture: opts.scored.capture,
      tokens_in: opts.session.tokens_in,
      tokens_out: opts.session.tokens_out,
      cost_usd: opts.session.cost_usd,
      corpus_file_access: opts.session.corpus_file_access,
      duration_s: opts.session.duration_s,
      turns: opts.session.turns,
    },
    transcript_path: opts.transcriptPath,
    diff_path: opts.diffPath,
    harness: opts.harness,
  };
}

/**
 * Hash of a config dir's artifacts, over files sorted by relative path so it is
 * deterministic and drift-sensitive. Path and content are both mixed in, so a
 * rename or an edit changes the hash (§8.2 "silent config drift is detectable").
 */
export function configHash(configDir: string): string {
  const hash = createHash('sha256');
  for (const rel of walkFiles(configDir)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(configDir, rel)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const recurse = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) recurse(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  recurse(dir, '');
  return out;
}
