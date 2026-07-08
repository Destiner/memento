// Running one headless Claude Code session in a sandbox (harness-spec §7.2 step 3).
//
// buildClaudeInvocation assembles the `claude -p` command: JSON output, the pinned
// model, and the sandbox's strict MCP config + isolated config home so nothing
// leaks from the operator's machine. Permissions are bypassed inside the
// disposable sandbox — Phase 1 measures propensity, not permission friction
// (§3.2), and the agent still needs Edit/Bash to complete tasks.
//
// parseSessionResult reads the single result object `--output-format json` prints
// and pulls out the diagnostics the results log records (§8.2): cost, duration,
// turns, and tokens. It is lenient — a crashed or timed-out session leaves no
// parseable result, which the caller treats as an invalid rep (§7.4).

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface InvocationInput {
  repoDir: string; // cwd for the session
  ccConfigDir: string; // CLAUDE_CONFIG_DIR (isolated config home)
  mcpConfigPath: string; // --mcp-config target
  task: string;
  model: string;
}

// Frictionless in the disposable sandbox (§3.2); memento is also pre-allowed in
// settings so the intent survives if this is ever tightened.
const PERMISSION_MODE = 'bypassPermissions';

export function buildClaudeInvocation(input: InvocationInput): Invocation {
  return {
    command: 'claude',
    args: [
      '--print',
      '--output-format',
      'json',
      '--model',
      input.model,
      '--mcp-config',
      input.mcpConfigPath,
      '--strict-mcp-config',
      '--permission-mode',
      PERMISSION_MODE,
      input.task,
    ],
    env: { ...process.env, CLAUDE_CONFIG_DIR: input.ccConfigDir },
    cwd: input.repoDir,
  };
}

export interface SessionResult {
  parsed: boolean; // a result object was recovered from stdout
  isError: boolean; // Claude reported the session as errored
  costUsd: number | null;
  durationS: number | null;
  turns: number | null;
  tokensIn: number | null; // input-side tokens, cache included (§5.3 guardrail)
  tokensOut: number | null;
  sessionId: string | null;
  resultText: string | null;
}

const UNPARSED: SessionResult = {
  parsed: false,
  isError: true,
  costUsd: null,
  durationS: null,
  turns: null,
  tokensIn: null,
  tokensOut: null,
  sessionId: null,
  resultText: null,
};

export function parseSessionResult(stdout: string): SessionResult {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return UNPARSED;
    obj = parsed as Record<string, unknown>;
  } catch {
    return UNPARSED;
  }

  const usage = isObject(obj.usage) ? obj.usage : {};
  const tokensIn = sumNums(
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  );
  const durationMs = num(obj.duration_ms);

  return {
    parsed: true,
    isError: obj.is_error === true,
    costUsd: num(obj.total_cost_usd),
    durationS: durationMs === null ? null : Math.round(durationMs / 1000),
    turns: num(obj.num_turns),
    tokensIn,
    tokensOut: num(usage.output_tokens),
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
    resultText: typeof obj.result === 'string' ? obj.result : null,
  };
}

export interface SessionRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationS: number;
}

// Injected so the timeout/watchdog wiring can be unit-tested without spawning a
// real `claude` (see session.test.ts). Defaults to node:child_process.spawn.
export type Spawn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

// Grace window after the soft `timeoutS` before the watchdog force-resolves.
// SIGKILL kills `claude` itself, but its MCP-server grandchildren (spawned via
// --mcp-config) inherit the stdio pipes; if they outlive the parent the pipes
// stay open and the child's 'close' never fires, so the promise would hang
// forever. This backstop makes runSession un-hangable past timeoutS + this (§7.4).
export const WATCHDOG_GRACE_S = 30;

/**
 * Spawn a `claude -p` session and capture its output, SIGKILLing it after
 * `timeoutS` (§7.4). Never rejects and never hangs: a spawn error, a timeout, or
 * a child whose 'close' never arrives all resolve with the captured streams and a
 * `timedOut` flag the caller reads to mark the rep invalid.
 *
 * A soft timer SIGKILLs at `timeoutS` and lets the normal 'close' path resolve
 * with full output. A hard-deadline watchdog at `timeoutS + WATCHDOG_GRACE_S` is
 * the backstop: it force-resolves regardless, covering both failure modes seen in
 * testing — a soft timer that never fired, and a SIGKILL whose 'close' never came
 * because orphaned pipe holders kept the streams open. `log` receives a single
 * watchdog line when that backstop trips.
 */
export function runSession(
  inv: Invocation,
  timeoutS: number,
  now: () => number,
  log: (msg: string) => void = () => {},
  spawnFn: Spawn = (command, args, opts) => nodeSpawn(command, args, opts),
): Promise<SessionRun> {
  return new Promise((resolve) => {
    const started = now();
    const child = spawnFn(inv.command, inv.args, { cwd: inv.cwd, env: inv.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, extraStderr = ''): void => {
      // A late 'close' can still arrive after the watchdog forced us out; ignore it.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      resolve({
        stdout,
        stderr: stderr + extraStderr,
        exitCode,
        timedOut,
        durationS: Math.round((now() - started) / 1000),
      });
    };

    // Soft timeout: SIGKILL and let the normal 'close' path resolve with output.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutS * 1000);

    // Hard deadline: force-resolve so a dead-but-unclosed child can never wedge a
    // scheduler worker slot forever (§7.4).
    const watchdog = setTimeout(
      () => {
        timedOut = true;
        log(
          `watchdog: session past ${timeoutS + WATCHDOG_GRACE_S}s hard deadline; forcing ` +
            `resolution (pid ${child.pid ?? '?'}, exit ${child.exitCode ?? 'null'}) — 'close' ` +
            'never fired, likely orphaned MCP-server pipe holders',
        );
        child.kill('SIGKILL');
        finish(
          child.exitCode ?? null,
          '\n[watchdog] hard deadline exceeded; output may be truncated',
        );
      },
      (timeoutS + WATCHDOG_GRACE_S) * 1000,
    );

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err: Error) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Sum the numeric arguments, returning null only if every one is absent.
function sumNums(...values: unknown[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    const n = num(value);
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}
