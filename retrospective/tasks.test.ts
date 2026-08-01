import { describe, expect, test } from 'vitest';

import { NORMALIZED_SCHEMA_VERSION, type NormalizedSession } from './model.js';
import { splitTasks } from './tasks.js';

function session(): NormalizedSession {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: 'session-1',
    client: 'codex',
    sourceSessionIds: ['source-1'],
    sourceIds: ['/logs/session.jsonl'],
    rootThreadId: 'root',
    threads: [
      { id: 'root', sourceSessionId: 'source-1' },
      { id: 'child', sourceSessionId: 'source-1', parentThreadId: 'root' },
    ],
    events: [
      {
        schemaVersion: 1,
        id: 'assistant-before',
        sessionId: 'session-1',
        threadId: 'root',
        sequence: 0,
        kind: 'assistant_message',
        role: 'assistant',
        text: 'ready',
      },
      {
        schemaVersion: 1,
        id: 'user-1',
        sessionId: 'session-1',
        threadId: 'root',
        sequence: 1,
        kind: 'user_message',
        role: 'user',
        text: 'first',
      },
      {
        schemaVersion: 1,
        id: 'child-user',
        sessionId: 'session-1',
        threadId: 'child',
        sequence: 2,
        kind: 'user_message',
        role: 'user',
        text: 'delegated prompt',
      },
      {
        schemaVersion: 1,
        id: 'assistant-1',
        sessionId: 'session-1',
        threadId: 'root',
        sequence: 3,
        kind: 'assistant_message',
        role: 'assistant',
        text: 'done',
      },
      {
        schemaVersion: 1,
        id: 'user-2',
        sessionId: 'session-1',
        threadId: 'root',
        sequence: 4,
        kind: 'user_message',
        role: 'user',
        text: 'second',
      },
      {
        schemaVersion: 1,
        id: 'assistant-2',
        sessionId: 'session-1',
        threadId: 'root',
        sequence: 5,
        kind: 'assistant_message',
        role: 'assistant',
        text: 'done again',
      },
    ],
    actualOperations: [
      {
        schemaVersion: 1,
        id: 'op-1',
        sessionId: 'session-1',
        threadId: 'root',
        callEventId: 'op-event-1',
        sequence: 3,
        tool: 'search_memories',
        kind: 'search',
        sourceToolName: 'mcp__memento__search_memories',
        callId: 'call-1',
        outcome: 'success',
      },
      {
        schemaVersion: 1,
        id: 'op-2',
        sessionId: 'session-1',
        threadId: 'root',
        callEventId: 'op-event-2',
        sequence: 5,
        tool: 'create_memory',
        kind: 'write',
        sourceToolName: 'mcp__memento__create_memory',
        callId: 'call-2',
        outcome: 'success',
      },
    ],
    policyVersion: '2.1.0',
    projectContext: { workingDirectory: '/repo' },
    warnings: [],
  };
}

describe('splitTasks', () => {
  test('splits only on root-thread user events and keeps child-thread chronology', () => {
    const tasks = splitTasks(session());
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.events.map((event) => event.id)).toEqual([
      'user-1',
      'child-user',
      'assistant-1',
    ]);
    expect(tasks[1]?.events.map((event) => event.id)).toEqual(['user-2', 'assistant-2']);
    expect(tasks[0]?.actualOperations.map((operation) => operation.id)).toEqual(['op-1']);
    expect(tasks[1]?.actualOperations.map((operation) => operation.id)).toEqual(['op-2']);
  });

  test('produces stable ids from the real user event and carries session context', () => {
    const [task] = splitTasks(session());
    expect(task?.id).toBe('session-1:task:user-1');
    expect(task?.rootUserEventId).toBe('user-1');
    expect(task?.projectContext).toEqual({ workingDirectory: '/repo' });
    expect(task?.policyVersion).toBe('2.1.0');
  });
});
