import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  anyCaptureAttempt,
  anyCaptureSuccess,
  anyMementoCall,
  loggedVariant,
  memoryWasStored,
  readMementoCalls,
  searchToGetRate,
  serverSessionIds,
  type MementoCall,
} from './event-log.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memento-eventlog-'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeLog(file: string, events: Array<Record<string, unknown>>): void {
  const logsDir = join(home, 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, file),
    events.map((event) => JSON.stringify(logEvent(event))).join('\n') + '\n',
  );
}

function logEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: 'evt_TEST',
    timestamp: '2026-07-07T10:00:00Z',
    latency_ms: 1,
    ...eventEnvelope(),
    ...event,
  };
}

function eventEnvelope(): Omit<MementoCall, 'tool' | 'outcome'> {
  return {
    session_id: 'ses_TEST',
    server_version: '0.3.2',
    policy_version: '2.1.0',
    variant: 'shipped-v2',
    log_schema_version: 2,
  };
}

function call(input: Pick<MementoCall, 'tool' | 'outcome'> & Partial<MementoCall>): MementoCall {
  return { ...eventEnvelope(), ...input };
}

describe('readMementoCalls', () => {
  test('returns [] when no logs directory exists', () => {
    expect(readMementoCalls(home)).toEqual([]);
  });

  test('reads calls across date-partitioned files, oldest first', () => {
    writeLog('events-2026-07-06.jsonl', [
      {
        session_id: 'ses_ONE',
        tool: 'search_memories',
        outcome: 'success',
        result_count: 1,
        result_ids: ['mem_ONE'],
        scope_kind: 'projects',
        project_count: 1,
        policy_version: '2.1.0',
      },
    ]);
    writeLog('events-2026-07-07.jsonl', [
      {
        tool: 'create_memory',
        outcome: 'success',
        result_outcome: 'created',
        memory_id: 'mem_TWO',
        memory_type: 'decision_history',
        scope_kind: 'projects',
        project_count: 1,
      },
    ]);
    const calls = readMementoCalls(home);
    expect(calls).toEqual([
      call({
        session_id: 'ses_ONE',
        tool: 'search_memories',
        outcome: 'success',
        result_count: 1,
        result_ids: ['mem_ONE'],
        scope_kind: 'projects',
        project_count: 1,
        policy_version: '2.1.0',
      }),
      call({
        tool: 'create_memory',
        outcome: 'success',
        result_outcome: 'created',
        memory_id: 'mem_TWO',
        memory_type: 'decision_history',
        scope_kind: 'projects',
        project_count: 1,
      }),
    ]);
  });

  test('skips blank and malformed lines and non-event files', () => {
    const logsDir = join(home, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'events-2026-07-07.jsonl'),
      [
        JSON.stringify(logEvent({ ...call({ tool: 'search_memories', outcome: 'success' }) })),
        '',
        'not json',
        JSON.stringify(['array', 'not', 'object']),
        JSON.stringify({ outcome: 'success' }), // no tool → skipped
        JSON.stringify(logEvent({ ...call({ tool: 'get_memory', outcome: 'error' }) })),
      ].join('\n'),
    );
    writeFileSync(join(logsDir, 'notes.txt'), 'ignored');
    const calls = readMementoCalls(home);
    expect(calls).toEqual([
      call({ tool: 'search_memories', outcome: 'success' }),
      call({ tool: 'get_memory', outcome: 'error' }),
    ]);
  });
});

describe('call predicates', () => {
  test('anyMementoCall is the read false positive: any call at all', () => {
    expect(anyMementoCall([])).toBe(false);
    expect(anyMementoCall([call({ tool: 'search_memories', outcome: 'success' })])).toBe(true);
  });

  test('anyCaptureAttempt counts create/update regardless of outcome', () => {
    expect(anyCaptureAttempt([call({ tool: 'search_memories', outcome: 'success' })])).toBe(false);
    expect(anyCaptureAttempt([call({ tool: 'create_memory', outcome: 'error' })])).toBe(true);
    expect(anyCaptureAttempt([call({ tool: 'update_memory', outcome: 'success' })])).toBe(true);
  });

  test('anyCaptureSuccess requires a landed write', () => {
    expect(anyCaptureSuccess([call({ tool: 'create_memory', outcome: 'error' })])).toBe(false);
    expect(
      anyCaptureSuccess([
        call({
          tool: 'create_memory',
          outcome: 'success',
          result_outcome: 'created',
          memory_id: 'mem_ONE',
        }),
      ]),
    ).toBe(true);
    expect(
      anyCaptureSuccess([
        call({
          tool: 'create_memory',
          outcome: 'success',
          result_outcome: 'duplicate_candidates',
        }),
      ]),
    ).toBe(false);
    expect(anyCaptureSuccess([call({ tool: 'search_memories', outcome: 'success' })])).toBe(false);
  });

  test('memoryWasStored links the landed event to the exact captured file', () => {
    const calls = [
      call({
        tool: 'create_memory',
        outcome: 'success',
        result_outcome: 'created',
        memory_id: 'mem_ONE',
      }),
    ];
    expect(memoryWasStored(calls, 'mem_ONE')).toBe(true);
    expect(memoryWasStored(calls, 'mem_OTHER')).toBe(false);
  });

  test('searchToGetRate checks whether a later get opened a returned id', () => {
    const calls = [
      call({
        tool: 'search_memories',
        outcome: 'success',
        result_ids: ['mem_ONE', 'mem_TWO'],
      }),
      call({ tool: 'get_memory', outcome: 'success', memory_id: 'mem_TWO' }),
      call({ tool: 'search_memories', outcome: 'success', result_ids: ['mem_THREE'] }),
    ];
    expect(searchToGetRate(calls)).toBe(0.5);
    expect(
      searchToGetRate([call({ tool: 'search_memories', outcome: 'success', result_ids: [] })]),
    ).toBeNull();
  });

  test('serverSessionIds exposes the process boundary without relying on mtimes', () => {
    expect(
      serverSessionIds([
        call({ session_id: 'ses_ONE', tool: 'resolve_project', outcome: 'success' }),
        call({ session_id: 'ses_ONE', tool: 'search_memories', outcome: 'success' }),
        call({ session_id: 'ses_TWO', tool: 'get_memory', outcome: 'success' }),
      ]),
    ).toEqual(['ses_ONE', 'ses_TWO']);
  });

  test('loggedVariant returns the resolved variant the server stamped, or null (§10)', () => {
    expect(loggedVariant([])).toBeNull();
    expect(
      loggedVariant([call({ tool: 'search_memories', outcome: 'success', variant: 'plain' })]),
    ).toBe('plain');
  });
});

describe('readMementoCalls — variant', () => {
  test('captures the resolved MEMENTO_VARIANT the server logged', () => {
    writeLog('events-2026-07-07.jsonl', [
      { tool: 'search_memories', outcome: 'success', result_count: 2, variant: 'plain' },
    ]);
    expect(readMementoCalls(home)).toEqual([
      call({ tool: 'search_memories', outcome: 'success', result_count: 2, variant: 'plain' }),
    ]);
  });
});
