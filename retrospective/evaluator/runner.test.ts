import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { NodeCommandRunner, WATCHDOG_GRACE_MS, type SpawnCommand } from './runner.js';
import type { CommandInvocation } from './types.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  return child;
}

const invocation: CommandInvocation = {
  command: 'evaluator',
  args: [],
  cwd: '/tmp',
  env: {},
};

afterEach(() => vi.useRealTimers());

describe('NodeCommandRunner', () => {
  test('watchdog resolves even when killed descendants keep process pipes open', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const runner = new NodeCommandRunner((() => child) as unknown as SpawnCommand);
    const resultPromise = runner.run({ ...invocation, timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(WATCHDOG_GRACE_MS);

    await expect(resultPromise).resolves.toMatchObject({ timedOut: true, exitCode: null });
  });

  test('kills and resolves when captured output exceeds its bound', async () => {
    const child = fakeChild();
    const runner = new NodeCommandRunner((() => child) as unknown as SpawnCommand);
    const resultPromise = runner.run({ ...invocation, maxOutputBytes: 3 });
    child.stdout.emit('data', Buffer.from('four'));

    await expect(resultPromise).resolves.toMatchObject({ outputLimitExceeded: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
