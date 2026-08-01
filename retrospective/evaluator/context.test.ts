import { describe, expect, test } from 'vitest';

import type { NormalizedTask } from '../tasks.js';
import {
  MAX_EVALUATION_CONTEXT_CHARS,
  MAX_EVALUATION_EVENTS,
  evaluationEvents,
} from './context.js';

function taskWithEvents(count: number, text = 'event'): NormalizedTask {
  return {
    schemaVersion: 1,
    id: 'task-1',
    sessionId: 'session-1',
    index: 0,
    rootUserEventId: 'event-0',
    client: 'codex',
    policyVersion: 'unknown',
    startSequence: 0,
    endSequence: count - 1,
    events: Array.from({ length: count }, (_, sequence) => ({
      schemaVersion: 1,
      id: `event-${sequence}`,
      sessionId: 'session-1',
      threadId: 'root',
      sequence,
      kind: sequence === 0 ? ('user_message' as const) : ('assistant_message' as const),
      role: sequence === 0 ? ('user' as const) : ('assistant' as const),
      text,
    })),
    actualOperations: [],
  };
}

describe('evaluationEvents bounds', () => {
  test('hides Memento operations without exposing sequence gaps', () => {
    const task = taskWithEvents(4);
    task.events[1] = {
      schemaVersion: 1,
      id: 'memento-call',
      sessionId: task.sessionId,
      threadId: 'root',
      sequence: 1,
      kind: 'tool_call',
      role: 'assistant',
      actualOperationId: 'operation-1',
      toolCall: {
        callId: 'call-1',
        name: 'mcp__memento__search_memories',
        isMemento: true,
      },
    };
    task.actualOperations = [
      {
        schemaVersion: 1,
        id: 'operation-1',
        sessionId: task.sessionId,
        threadId: 'root',
        callEventId: 'memento-call',
        sequence: 1,
        tool: 'search_memories',
        kind: 'search',
        sourceToolName: 'mcp__memento__search_memories',
        callId: 'call-1',
        outcome: 'success',
      },
    ];

    const events = evaluationEvents(task, 'capture');

    expect(events.map((event) => event.id)).toEqual(['event-0', 'event-2', 'event-3']);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  test('deterministically samples oversized tasks across their full timeline', () => {
    const task = taskWithEvents(MAX_EVALUATION_EVENTS * 3, 'x'.repeat(1_000));

    const first = evaluationEvents(task, 'search');
    const second = evaluationEvents(task, 'search');

    expect(first).toEqual(second);
    expect(first).toHaveLength(MAX_EVALUATION_EVENTS);
    expect(first[0]?.id).toBe('event-0');
    expect(first.at(-1)?.id).toBe(`event-${MAX_EVALUATION_EVENTS * 3 - 1}`);
    expect(
      first.some((event) => {
        const sourceSequence = Number(event.id.slice('event-'.length));
        return sourceSequence > MAX_EVALUATION_EVENTS && sourceSequence < MAX_EVALUATION_EVENTS * 2;
      }),
    ).toBe(true);
    expect(
      first.some((event) => {
        const sourceSequence = Number(event.id.slice('event-'.length));
        return (
          sourceSequence > MAX_EVALUATION_EVENTS * 2 &&
          sourceSequence < MAX_EVALUATION_EVENTS * 3 - 100
        );
      }),
    ).toBe(true);
    expect(first.map((event) => event.sequence)).toEqual(first.map((_event, sequence) => sequence));
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(MAX_EVALUATION_CONTEXT_CHARS);
  });

  test('recursively bounds large text and tool values within the context limit', () => {
    const task = taskWithEvents(80, 'x'.repeat(20_000));
    task.events[40] = {
      schemaVersion: 1,
      id: 'large-tool-event',
      sessionId: task.sessionId,
      threadId: 'root',
      sequence: 40,
      kind: 'tool_call',
      role: 'assistant',
      toolCall: {
        callId: 'large-tool-call',
        name: 'read_file',
        isMemento: false,
        input: {
          nested: {
            values: Array.from({ length: 300 }, (_, index) => ({
              index,
              content: `prefix-${index}-${'y'.repeat(5_000)}-suffix-${index}`,
            })),
          },
        },
      },
    };

    const events = evaluationEvents(task, 'capture');
    const serialized = JSON.stringify(events);

    expect(events).toHaveLength(80);
    expect(serialized.length).toBeLessThanOrEqual(MAX_EVALUATION_CONTEXT_CHARS);
    expect(serialized).toContain('[TRUNCATED:');
    expect(
      events.map((event) => event.id).every((id) => task.events.some((event) => event.id === id)),
    ).toBe(true);
  });

  test('masks assistant narration emitted in the same source message as a Memento call', () => {
    const task = taskWithEvents(5);
    task.events[1] = {
      ...task.events[1]!,
      id: 'ordinary-narration',
      sourceMessageId: 'source-message-ordinary',
      text: 'I will inspect the implementation.',
    };
    task.events[2] = {
      ...task.events[2]!,
      id: 'memory-narration',
      sourceMessageId: 'source-message-memory-call',
      text: 'I will check memory first.',
    };
    task.events[3] = {
      schemaVersion: 1,
      id: 'memento-call',
      sessionId: task.sessionId,
      threadId: 'root',
      sourceMessageId: 'source-message-memory-call',
      sequence: 3,
      kind: 'tool_call',
      role: 'assistant',
      actualOperationId: 'operation-1',
      toolCall: {
        callId: 'call-1',
        name: 'mcp__memento__search_memories',
        isMemento: true,
      },
    };
    task.actualOperations = [
      {
        schemaVersion: 1,
        id: 'operation-1',
        sessionId: task.sessionId,
        threadId: 'root',
        callEventId: 'memento-call',
        sequence: 3,
        tool: 'search_memories',
        kind: 'search',
        sourceToolName: 'mcp__memento__search_memories',
        callId: 'call-1',
        outcome: 'unknown',
      },
    ];

    const events = evaluationEvents(task, 'search');

    expect(events.map((event) => event.id)).toEqual(['event-0', 'ordinary-narration', 'event-4']);
  });

  test('conservatively flags and masks later text that quotes retrieved memory', () => {
    const retrieved =
      'The production migration must retain legacy tenant aliases until all regional workers have completed the version-three schema rollout.';
    const task = taskWithEvents(6);
    task.events[1] = {
      schemaVersion: 1,
      id: 'memento-call',
      sessionId: task.sessionId,
      threadId: 'root',
      sourceMessageId: 'memory-call-message',
      sequence: 1,
      kind: 'tool_call',
      role: 'assistant',
      actualOperationId: 'operation-1',
      toolCall: {
        callId: 'call-1',
        name: 'mcp__memento__search_memories',
        isMemento: true,
      },
    };
    task.events[2] = {
      schemaVersion: 1,
      id: 'memento-result',
      sessionId: task.sessionId,
      threadId: 'root',
      sourceMessageId: 'memory-result-message',
      sequence: 2,
      kind: 'tool_result',
      role: 'tool',
      actualOperationId: 'operation-1',
      toolCallId: 'call-1',
      toolOutput: { memories: [{ content: retrieved }] },
    };
    task.events[3] = {
      ...task.events[3]!,
      text: `The relevant constraint says: ${retrieved}`,
    };
    task.events[4] = {
      ...task.events[4]!,
      text: 'I will now update the migration test.',
    };
    task.actualOperations = [
      {
        schemaVersion: 1,
        id: 'operation-1',
        sessionId: task.sessionId,
        threadId: 'root',
        callEventId: 'memento-call',
        resultEventId: 'memento-result',
        sequence: 1,
        tool: 'search_memories',
        kind: 'search',
        sourceToolName: 'mcp__memento__search_memories',
        callId: 'call-1',
        output: { memories: [{ content: retrieved }] },
        outcome: 'success',
      },
    ];

    const events = evaluationEvents(task, 'capture');
    const influenced = events.find((event) => event.id === 'event-3');
    const ordinary = events.find((event) => event.id === 'event-4');

    expect(influenced).toMatchObject({ contentMasked: 'possible_memory_influence' });
    expect(influenced).not.toHaveProperty('text');
    expect(ordinary?.text).toBe('I will now update the migration test.');
    expect(JSON.stringify(events)).not.toContain(retrieved);
  });
});
