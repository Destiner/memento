import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildClaudeInvocation,
  parseSessionResult,
  runSession,
  WATCHDOG_GRACE_S,
  type Invocation,
  type Spawn,
} from './session.js';

describe('buildClaudeInvocation', () => {
  const inv = buildClaudeInvocation({
    repoDir: '/sandbox/repo',
    ccConfigDir: '/sandbox/cc-config',
    mcpConfigPath: '/sandbox/mcp.json',
    task: 'Add email sending for password resets.',
    model: 'claude-opus-4-8',
  });

  test('runs claude -p with JSON output, the pinned model, and strict MCP config', () => {
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual([
      '--print',
      '--output-format',
      'json',
      '--model',
      'claude-opus-4-8',
      '--mcp-config',
      '/sandbox/mcp.json',
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      'Add email sending for password resets.',
    ]);
  });

  test('isolates the config home and runs in the fixture copy', () => {
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe('/sandbox/cc-config');
    expect(inv.cwd).toBe('/sandbox/repo');
  });
});

describe('parseSessionResult', () => {
  test('extracts cost, duration, turns, and tokens from a success result', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      total_cost_usd: 0.42,
      duration_ms: 141000,
      num_turns: 9,
      session_id: 'sess_1',
      result: 'done',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
        output_tokens: 200,
      },
    });
    const result = parseSessionResult(stdout);
    expect(result.parsed).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.costUsd).toBe(0.42);
    expect(result.durationS).toBe(141);
    expect(result.turns).toBe(9);
    expect(result.tokensIn).toBe(1050); // input + cache read + cache creation
    expect(result.tokensOut).toBe(200);
    expect(result.sessionId).toBe('sess_1');
    expect(result.resultText).toBe('done');
  });

  test('marks unparseable output (crash/timeout) as errored', () => {
    const result = parseSessionResult('');
    expect(result.parsed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.tokensIn).toBeNull();
  });

  test('tolerates a missing usage block', () => {
    const result = parseSessionResult(JSON.stringify({ is_error: false, total_cost_usd: 0.1 }));
    expect(result.parsed).toBe(true);
    expect(result.tokensIn).toBeNull();
    expect(result.tokensOut).toBeNull();
  });
});

describe('runSession', () => {
  const INV: Invocation = { command: 'claude', args: [], env: {}, cwd: '/tmp' };

  // A ChildProcess stand-in: EventEmitter with stdout/stderr streams and a
  // kill() we can assert on, so the timeout/watchdog wiring is exercised without
  // spawning a real process.
  function fakeChild(): EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: number | null;
  } {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.kill = vi.fn(() => true);
    return child as never;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('resolves on close with captured output and no timeout', async () => {
    const child = fakeChild();
    const spawnFn = (() => child) as unknown as Spawn;
    const promise = runSession(
      INV,
      600,
      () => Date.now(),
      () => {},
      spawnFn,
    );

    child.stdout.emit('data', Buffer.from('{"ok":true}'));
    child.exitCode = 0;
    child.emit('close', 0);

    const run = await promise;
    expect(run.stdout).toBe('{"ok":true}');
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('watchdog force-resolves when close never fires after the SIGKILL', async () => {
    const child = fakeChild();
    const spawnFn = (() => child) as unknown as Spawn;
    const log = vi.fn();
    const promise = runSession(INV, 600, () => Date.now(), log, spawnFn);

    // Soft timeout fires and SIGKILLs, but grandchildren hold the pipes open so
    // 'close' never comes — without the watchdog this promise would hang forever.
    await vi.advanceTimersByTimeAsync(600 * 1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // The hard deadline is the backstop that unblocks it.
    await vi.advanceTimersByTimeAsync(WATCHDOG_GRACE_S * 1000);
    const run = await promise;
    expect(run.timedOut).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(run.stderr).toContain('[watchdog] hard deadline exceeded');
  });

  test('watchdog fires even if the soft timer never SIGKILLed', async () => {
    // Covers the "timeout either didn't fire" arm: the hard deadline still resolves.
    const child = fakeChild();
    const spawnFn = (() => child) as unknown as Spawn;
    const log = vi.fn();
    const promise = runSession(INV, 600, () => Date.now(), log, spawnFn);

    await vi.advanceTimersByTimeAsync((600 + WATCHDOG_GRACE_S) * 1000);
    const run = await promise;
    expect(run.timedOut).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('a late close after the watchdog does not double-resolve', async () => {
    const child = fakeChild();
    const spawnFn = (() => child) as unknown as Spawn;
    const promise = runSession(
      INV,
      600,
      () => Date.now(),
      () => {},
      spawnFn,
    );

    await vi.advanceTimersByTimeAsync((600 + WATCHDOG_GRACE_S) * 1000);
    const run = await promise;
    expect(run.timedOut).toBe(true);

    // The orphaned pipes finally close much later; finish() must ignore it.
    expect(() => child.emit('close', 137)).not.toThrow();
    expect(run.exitCode).toBeNull();
  });
});
