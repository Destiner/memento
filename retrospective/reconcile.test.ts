import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCodexHistory } from './adapters/codex.js';
import { mergeParsedThreads } from './ingest.js';
import { reconcileTelemetry, type TelemetryEvent } from './reconcile.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-history.jsonl', import.meta.url));

describe('telemetry reconciliation', () => {
  it('attaches a unique match and adopts a fully established policy version', async () => {
    const session = await codexSession();
    for (const operation of session.actualOperations) operation.outcome = 'unknown';
    const telemetry: TelemetryEvent[] = session.actualOperations.map((operation, index) => ({
      event_id: `log-${index}`,
      timestamp: operation.timestamp!,
      tool: operation.sourceToolName,
      outcome: operation.outcome === 'unknown' ? 'success' : operation.outcome,
      policy_version: '2.0.0',
      server_version: '0.3.2',
      variant: 'shipped-v2',
      client_name: 'codex',
      client_version: '0.145.0',
      log_schema_version: 2,
      result_outcome: 'completed',
      candidate_ids: ['mem_CANDIDATE01'],
      ...(operation.memoryIds?.[0] ? { memory_id: operation.memoryIds[0] } : {}),
    }));

    const result = reconcileTelemetry([session], telemetry);
    expect(result.matches).toHaveLength(2);
    expect(result.ambiguous).toEqual([]);
    expect(result.sessions[0]?.policyVersion).toBe('2.0.0');
    expect(result.sessions[0]?.actualOperations.every((operation) => operation.telemetry)).toBe(
      true,
    );
    expect(
      result.sessions[0]?.actualOperations.every((operation) => operation.outcome === 'success'),
    ).toBe(true);
    expect(result.sessions[0]?.actualOperations[0]?.telemetry).toMatchObject({
      variant: 'shipped-v2',
      clientVersion: '0.145.0',
      logSchemaVersion: 2,
      resultOutcome: 'completed',
      candidateIds: ['mem_CANDIDATE01'],
    });
  });

  it('does not guess when multiple telemetry events could be the same operation', async () => {
    const session = await codexSession();
    session.actualOperations = [session.actualOperations[1]!];
    const operation = session.actualOperations[0]!;
    const candidate = (id: string): TelemetryEvent => ({
      event_id: id,
      timestamp: operation.timestamp!,
      tool: operation.sourceToolName,
      outcome: 'success',
      policy_version: '2.0.0',
    });

    const result = reconcileTelemetry([session], [candidate('first'), candidate('second')]);
    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual([
      { operationId: operation.id, candidateTelemetryEventIds: ['first', 'second'] },
    ]);
    expect(result.sessions[0]?.policyVersion).toBe('unknown');
  });

  it('does not reconcile concurrent sessions from tool, client, time, or server session ids', async () => {
    const original = await codexSession();
    const template = original.actualOperations[1]!;
    const first = structuredClone(original);
    first.id = 'session-first';
    first.actualOperations = [
      {
        ...template,
        id: 'operation-first',
        sessionId: first.id,
        timestamp: '2026-07-02T10:00:05.000Z',
        memoryIds: undefined,
      },
    ];
    const second = structuredClone(original);
    second.id = 'session-second';
    second.actualOperations = [
      {
        ...template,
        id: 'operation-second',
        sessionId: second.id,
        timestamp: '2026-07-02T10:00:05.100Z',
        memoryIds: undefined,
      },
    ];
    const telemetry: TelemetryEvent[] = [
      {
        event_id: 'event-first',
        timestamp: '2026-07-02T10:00:05.000Z',
        tool: template.sourceToolName,
        client_name: 'codex',
        session_id: first.id,
      },
      {
        event_id: 'event-second',
        timestamp: '2026-07-02T10:00:05.100Z',
        tool: template.sourceToolName,
        client_name: 'codex',
        session_id: second.id,
      },
    ];

    const result = reconcileTelemetry([first, second], telemetry, { maxClockSkewMs: 25 });

    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedOperationIds).toEqual(['operation-first', 'operation-second']);
    expect(result.unmatchedTelemetryEventIds).toEqual(['event-first', 'event-second']);
  });

  it('accepts a unique exact project identity match', async () => {
    const session = await codexSession();
    session.actualOperations = [
      { ...session.actualOperations[0]!, memoryIds: undefined, outcome: 'unknown' },
    ];
    const operation = session.actualOperations[0]!;
    const telemetry: TelemetryEvent = {
      event_id: 'project-match',
      timestamp: operation.timestamp!,
      tool: operation.sourceToolName,
      outcome: 'success',
      project_ids: ['prj_01TEST'],
    };

    const result = reconcileTelemetry([session], [telemetry]);

    expect(result.matches).toEqual([
      { operationId: operation.id, telemetryEventId: telemetry.event_id },
    ]);
    expect(result.sessions[0]?.actualOperations[0]?.outcome).toBe('success');
  });
});

async function codexSession() {
  const raw = await readFile(fixture, 'utf8');
  const parsed = parseCodexHistory(raw, { sourceId: 'codex-fixture' });
  if (!parsed) throw new Error('Fixture did not parse.');
  return mergeParsedThreads([parsed])[0]!;
}
