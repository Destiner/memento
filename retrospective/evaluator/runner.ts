import { spawn } from 'node:child_process';

import type { CommandInvocation, CommandResult, CommandRunner } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
export const WATCHDOG_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type SpawnCommand = typeof spawn;

export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly spawnCommand: SpawnCommand = spawn) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnCommand(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = invocation.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(watchdog);
        resolve({ stdout, stderr, exitCode, timedOut, outputLimitExceeded });
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode);
      }, timeoutMs + WATCHDOG_GRACE_MS);

      const enforceOutputLimit = (): void => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxOutputBytes) return;
        outputLimitExceeded = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        enforceOutputLimit();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        enforceOutputLimit();
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(watchdog);
        reject(error);
      });
      child.on('close', finish);

      if (invocation.stdin !== undefined) child.stdin.end(invocation.stdin);
      else child.stdin.end();
    });
  }
}
