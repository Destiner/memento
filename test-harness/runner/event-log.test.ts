import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  anyCaptureAttempt,
  anyCaptureSuccess,
  anyMementoCall,
  readMementoCalls,
} from './event-log.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memento-eventlog-'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeLog(file: string, events: Array<Record<string, unknown>>): void {
  const logsDir = join(home, 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, file), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('readMementoCalls', () => {
  test('returns [] when no logs directory exists', () => {
    expect(readMementoCalls(home)).toEqual([]);
  });

  test('reads calls across date-partitioned files, oldest first', () => {
    writeLog('events-2026-07-06.jsonl', [{ tool: 'search_memory', outcome: 'success' }]);
    writeLog('events-2026-07-07.jsonl', [
      {
        tool: 'create_memory',
        outcome: 'success',
        memory_type: 'decision',
        memory_scope: 'cross_project',
      },
    ]);
    const calls = readMementoCalls(home);
    expect(calls).toEqual([
      { tool: 'search_memory', outcome: 'success' },
      {
        tool: 'create_memory',
        outcome: 'success',
        memory_type: 'decision',
        memory_scope: 'cross_project',
      },
    ]);
  });

  test('skips blank and malformed lines and non-event files', () => {
    const logsDir = join(home, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'events-2026-07-07.jsonl'),
      [
        JSON.stringify({ tool: 'search_memory', outcome: 'success' }),
        '',
        'not json',
        JSON.stringify(['array', 'not', 'object']),
        JSON.stringify({ outcome: 'success' }), // no tool → skipped
        JSON.stringify({ tool: 'read_memory', outcome: 'error' }),
      ].join('\n'),
    );
    writeFileSync(join(logsDir, 'notes.txt'), 'ignored');
    const calls = readMementoCalls(home);
    expect(calls).toEqual([
      { tool: 'search_memory', outcome: 'success' },
      { tool: 'read_memory', outcome: 'error' },
    ]);
  });
});

describe('call predicates', () => {
  test('anyMementoCall is the read false positive: any call at all', () => {
    expect(anyMementoCall([])).toBe(false);
    expect(anyMementoCall([{ tool: 'search_memory', outcome: 'success' }])).toBe(true);
  });

  test('anyCaptureAttempt counts create/update regardless of outcome', () => {
    expect(anyCaptureAttempt([{ tool: 'search_memory', outcome: 'success' }])).toBe(false);
    expect(anyCaptureAttempt([{ tool: 'create_memory', outcome: 'error' }])).toBe(true);
    expect(anyCaptureAttempt([{ tool: 'update_memory', outcome: 'success' }])).toBe(true);
  });

  test('anyCaptureSuccess requires a landed write', () => {
    expect(anyCaptureSuccess([{ tool: 'create_memory', outcome: 'error' }])).toBe(false);
    expect(anyCaptureSuccess([{ tool: 'create_memory', outcome: 'success' }])).toBe(true);
    expect(anyCaptureSuccess([{ tool: 'search_memory', outcome: 'success' }])).toBe(false);
  });
});
