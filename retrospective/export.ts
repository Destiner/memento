import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RetrospectiveStore } from './db/store.js';
import { stableJson } from './db/id.js';
import type { ComparisonKind, ComparisonLabel, ReviewState } from './db/types.js';
import type { HistoryClient, JsonValue } from './model.js';
import { redactJson } from './redact.js';

export const REGRESSION_EXPORT_SCHEMA_VERSION = 1 as const;

export interface RegressionCase {
  schemaVersion: typeof REGRESSION_EXPORT_SCHEMA_VERSION;
  id: string;
  runId: string;
  taskId: string;
  client: HistoryClient;
  model?: string;
  sourcePolicyVersion: string;
  evaluator?: JsonValue;
  kind: ComparisonKind;
  context?: JsonValue;
  taskSummary?: string;
  proposal?: JsonValue;
  actualOperation?: JsonValue;
  expected: {
    label: ComparisonLabel;
    decision: Exclude<ReviewState, 'pending'>;
    reviewerAction: 'approve' | 'edit' | 'reject' | 'duplicate';
    reason?: string;
    duplicateTargetMemoryId?: string;
  };
}

export function buildRegressionCases(store: RetrospectiveStore, runId: string): RegressionCase[] {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`Unknown retrospective run: ${runId}`);
  const rows = store.query<ExportRow>(
    `SELECT c.id, c.task_id, c.kind, c.label, t.summary, s.client, s.model,
            p.payload_json AS proposal_json, p.evaluator_json,
            COALESCE(cp.context_json, t.context_json) AS context_json
     FROM comparisons c
     JOIN tasks t ON t.run_id = c.run_id AND t.id = c.task_id
     JOIN sessions s ON s.run_id = t.run_id AND s.id = t.session_id
     LEFT JOIN proposals p ON p.id = c.proposal_id
     LEFT JOIN checkpoints cp ON cp.run_id = p.run_id AND cp.id = p.checkpoint_id
     WHERE c.run_id = ?
     ORDER BY c.created_at, c.id`,
    runId,
  );
  const itemById = new Map(store.listReviewed(runId).map((item) => [item.id, item]));

  return rows.flatMap((row) => {
    const item = itemById.get(row.id);
    if (item === undefined) return [];
    const decision = item.reviewEvents.at(-1);
    if (decision === undefined || decision.action === undefined) return [];
    const effectiveProposal = item.revision ?? parseOptional(row.proposal_json);
    const draft: RegressionCase = {
      schemaVersion: REGRESSION_EXPORT_SCHEMA_VERSION,
      id: `regression:${row.id}`,
      runId,
      taskId: row.task_id,
      client: row.client,
      ...(row.model === null ? {} : { model: row.model }),
      sourcePolicyVersion: run.sourcePolicyVersion,
      ...(row.evaluator_json === null && run.evaluator === undefined
        ? {}
        : {
            evaluator:
              row.evaluator_json === null
                ? asJson(run.evaluator!)
                : parseOptional(row.evaluator_json),
          }),
      kind: row.kind,
      ...(row.context_json === null ? {} : { context: parseOptional(row.context_json) }),
      ...(row.summary === null ? {} : { taskSummary: row.summary }),
      ...(effectiveProposal === undefined ? {} : { proposal: effectiveProposal }),
      ...(item.actualOperation === undefined ? {} : { actualOperation: item.actualOperation }),
      expected: {
        label: item.label,
        decision: item.state as Exclude<ReviewState, 'pending'>,
        reviewerAction: decision.action,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.duplicateTargetMemoryId === undefined
          ? {}
          : { duplicateTargetMemoryId: decision.duplicateTargetMemoryId }),
      },
    };
    return [sanitize(draft as unknown as JsonValue) as unknown as RegressionCase];
  });
}

export function buildRegressionJsonl(store: RetrospectiveStore, runId: string): string {
  const cases = buildRegressionCases(store, runId);
  return cases.length === 0
    ? ''
    : `${cases.map((item) => stableJson(item as unknown as JsonValue)).join('\n')}\n`;
}

export async function exportRegressionJsonl(
  store: RetrospectiveStore,
  runId: string,
  outputPath: string,
): Promise<{ path: string; cases: number }> {
  const cases = buildRegressionCases(store, runId);
  const contents =
    cases.length === 0
      ? ''
      : `${cases.map((item) => stableJson(item as unknown as JsonValue)).join('\n')}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return { path: outputPath, cases: cases.length };
}

interface ExportRow {
  id: string;
  task_id: string;
  kind: ComparisonKind;
  label: ComparisonLabel;
  summary: string | null;
  client: HistoryClient;
  model: string | null;
  proposal_json: string | null;
  evaluator_json: string | null;
  context_json: string | null;
}

const OMITTED_KEYS = new Set([
  'path',
  'rawpath',
  'workingdirectory',
  'workingdirectories',
  'sourceid',
  'sourceids',
  'sourcesessionid',
  'sourcesessionids',
]);

function sanitize(value: JsonValue): JsonValue {
  const redacted = redactJson(value);
  if (!redacted.ok) throw new Error(`Regression export failed redaction: ${redacted.reason}`);
  return omitInternalFields(redacted.value);
}

function omitInternalFields(value: JsonValue): JsonValue {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(omitInternalFields);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMITTED_KEYS.has(key.toLowerCase()))
        .map(([key, entry]) => [key, omitInternalFields(entry)]),
    );
  }
  return value;
}

function sanitizeString(value: string): string {
  return value
    .replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"']+/g, '<path>')
    .replace(/[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']+/g, '<path>');
}

function parseOptional(value: string | null): JsonValue | undefined {
  return value === null ? undefined : (JSON.parse(value) as JsonValue);
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
