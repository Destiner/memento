import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  findCapturedMemories,
  scoreCapture,
  seededBaseline,
  type CapturedMemory,
} from './capture.js';
import { type MementoCall } from './event-log.js';
import { type CaptureRubric } from './scenario.js';

const STORED: MementoCall[] = [{ tool: 'create_memory', outcome: 'success' }];

// A well-formed capture: records the insight, correct scope, usable body.
const GOOD: CapturedMemory = {
  id: 'mem_GOOD',
  title: 'Vendor sandbox API rate limit',
  scope: 'cross_project',
  body: [
    '## Summary',
    '',
    'The vendor sandbox API rejects more than 10 requests per minute; batch',
    'sends must throttle or they are dropped.',
    '',
    '## Guidance',
    '',
    'Throttle batch sends to under 10 req/min.',
  ].join('\n'),
};

const RUBRIC: CaptureRubric = {
  insight_regex: '(?i)10 requests per minute',
  expected_scope: ['cross_project', 'external_tooling'],
};

describe('scoreCapture', () => {
  test('passes when a successful write records the insight in a usable, well-scoped body', () => {
    const result = scoreCapture(STORED, [GOOD], RUBRIC);
    expect(result.passed).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.memory_id).toBe('mem_GOOD');
    expect(result.criteria).toEqual({
      stored: true,
      insight: true,
      durable: true,
      layer: true,
      body: true,
    });
  });

  test('fails C1 when no write succeeded, even with a perfect memory on disk', () => {
    const result = scoreCapture([{ tool: 'create_memory', outcome: 'error' }], [GOOD], RUBRIC);
    expect(result.passed).toBe(false);
    expect(result.attempted).toBe(false);
    expect(result.criteria.stored).toBe(false);
  });

  test('fails C2 when the insight is absent', () => {
    const noInsight = { ...GOOD, body: '## Summary\n\nWe wired up the mailer.' };
    const result = scoreCapture(STORED, [noInsight], RUBRIC);
    expect(result.passed).toBe(false);
    expect(result.criteria.insight).toBe(false);
  });

  test('fails C2 when an anti-pattern contradicts the insight', () => {
    const rubric: CaptureRubric = { ...RUBRIC, insight_anti_regex: '(?i)unlimited' };
    const contradicted = {
      ...GOOD,
      body: GOOD.body + '\n\nThe quota is effectively unlimited.',
    };
    expect(scoreCapture(STORED, [contradicted], rubric).criteria.insight).toBe(false);
  });

  test('fails C3 when the memory reads as a task log', () => {
    const taskLog = {
      ...GOOD,
      title: 'Completed the password-reset task',
      body: '## Summary\n\nFinished the task: sends 10 requests per minute now.',
    };
    const result = scoreCapture(STORED, [taskLog], RUBRIC);
    expect(result.criteria.durable).toBe(false);
    expect(result.passed).toBe(false);
  });

  test('honors a scenario-supplied task-log anti-pattern', () => {
    const rubric: CaptureRubric = { ...RUBRIC, task_log_anti_regex: '(?i)wired up' };
    const chatty = { ...GOOD, title: 'Wired up throttling for 10 requests per minute' };
    expect(scoreCapture(STORED, [chatty], rubric).criteria.durable).toBe(false);
  });

  test('fails C4 when the capture is mis-scoped', () => {
    const misScoped = { ...GOOD, scope: 'project' };
    const result = scoreCapture(STORED, [misScoped], RUBRIC);
    expect(result.criteria.layer).toBe(false);
    expect(result.passed).toBe(false);
  });

  test('C4 accepts any valid scope when expected_scope is omitted', () => {
    const rubric: CaptureRubric = { insight_regex: '(?i)10 requests per minute' };
    const result = scoreCapture(STORED, [{ ...GOOD, scope: 'project' }], rubric);
    expect(result.criteria.layer).toBe(true);
  });

  test('fails C5 when the body has no Summary section', () => {
    const noSummary = {
      ...GOOD,
      body: '## Context\n\nThe vendor sandbox API rejects more than 10 requests per minute.',
    };
    const result = scoreCapture(STORED, [noSummary], RUBRIC);
    expect(result.criteria.body).toBe(false);
    expect(result.passed).toBe(false);
  });

  test('reports all-false criteria when nothing was captured', () => {
    const result = scoreCapture([], [], RUBRIC);
    expect(result).toEqual({
      attempted: false,
      passed: false,
      criteria: { stored: false, insight: false, durable: false, layer: false, body: false },
      memory_id: null,
    });
  });

  test('picks the passing memory among several candidates', () => {
    const junk = { ...GOOD, id: 'mem_JUNK', body: '## Summary\n\nunrelated' };
    const result = scoreCapture(STORED, [junk, GOOD], RUBRIC);
    expect(result.passed).toBe(true);
    expect(result.memory_id).toBe('mem_GOOD');
  });
});

describe('findCapturedMemories + seededBaseline', () => {
  let root: string; // stands in for the harness root
  let home: string; // stands in for MEMENTO_HOME

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memento-cap-root-'));
    home = mkdtempSync(join(tmpdir(), 'memento-cap-home-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const memory = (title: string, scope: string) =>
    `---\nid: mem_X\ntitle: ${title}\nscope: ${scope}\n---\n\n## Summary\n\n${title}.\n`;

  test('seededBaseline reads the corpus dir and the optional retrieve fact', () => {
    mkdirSync(join(root, 'corpus', 'mini'), { recursive: true });
    writeFileSync(join(root, 'corpus', 'mini', 'a.md'), memory('A', 'project'));
    writeFileSync(join(root, 'corpus', 'mini', 'note.txt'), 'ignored');
    mkdirSync(join(root, 'facts'), { recursive: true });
    writeFileSync(join(root, 'facts', 'fact.md'), memory('Fact', 'cross_project'));

    const baseline = seededBaseline(root, 'corpus/mini', 'facts/fact.md');
    expect([...baseline.keys()].sort()).toEqual(['a.md', 'fact.md']);
  });

  test('treats new and edited files as captures, untouched distractors as not', () => {
    const memoriesDir = join(home, 'memories');
    mkdirSync(memoriesDir, { recursive: true });
    // Seed two distractors; leave one untouched, edit the other, and add a new one.
    const distractorA = memory('Distractor A', 'project');
    const distractorB = memory('Distractor B', 'project');
    mkdirSync(join(root, 'corpus', 'mini'), { recursive: true });
    writeFileSync(join(root, 'corpus', 'mini', 'a.md'), distractorA);
    writeFileSync(join(root, 'corpus', 'mini', 'b.md'), distractorB);

    writeFileSync(join(memoriesDir, 'a.md'), distractorA); // untouched
    writeFileSync(join(memoriesDir, 'b.md'), memory('Distractor B edited', 'cross_project')); // edited
    writeFileSync(join(memoriesDir, 'new.md'), memory('Fresh insight', 'external_tooling')); // new

    const baseline = seededBaseline(root, 'corpus/mini');
    const captured = findCapturedMemories(home, baseline);
    const titles = captured.map((m) => m.title).sort();
    expect(titles).toEqual(['Distractor B edited', 'Fresh insight']);
  });

  test('returns [] when the memories directory is absent', () => {
    expect(findCapturedMemories(home, new Map())).toEqual([]);
  });
});
