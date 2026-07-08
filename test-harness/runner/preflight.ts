// Run preflight (§7.2): prove the memento MCP server actually boots and answers
// an `initialize` handshake for every variant the run uses, BEFORE any paid
// session launches. A server that dies at startup is invisible downstream —
// Claude Code reports it as "connecting", the model never sees the tools, and
// every rep records zero memento calls, which reads exactly like "the model
// chose not to use memory" (the screening-1 failure). A dead server must abort
// the run loudly, not fabricate a behavioral result.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mementoServer, type McpServerSpec } from './mcp.js';

const INITIALIZE_REQUEST =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memento-harness-preflight', version: '0' },
    },
  }) + '\n';

/** Rebuild dist/ when missing or older than any file under src/. */
export function ensureMementoBuilt(repoRoot: string): void {
  const entry = join(repoRoot, 'dist', 'main.js');
  if (!existsSync(entry) || statSync(entry).mtimeMs < newestMtime(join(repoRoot, 'src'))) {
    execFileSync('bun', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
    }
  }
  return newest;
}

/**
 * Spawn an MCP stdio server and await a successful `initialize` response.
 * Resolves on handshake; rejects with the server's stderr tail on exit,
 * malformed/error response, or timeout.
 */
export function probeMcpServer(spec: McpServerSpec, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve();
    };
    const fail = (reason: string): void =>
      settle(new Error(`MCP preflight failed (${spec.command} ${spec.args.join(' ')}): ${reason}`));
    const timer = setTimeout(() => fail(`no initialize response within ${timeoutMs}ms`), timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id === 1 && msg.result !== undefined) return settle();
          if (msg.id === 1 && msg.error !== undefined)
            return fail(`initialize error: ${JSON.stringify(msg.error)}`);
        } catch {
          // Partial line; keep buffering.
        }
      }
    });
    child.on('error', (error) => fail(`spawn failed: ${error.message}`));
    child.on('exit', (code) =>
      fail(
        `server exited with code ${String(code)} before handshake. stderr: ${stderr.slice(-500)}`,
      ),
    );
    child.stdin.write(INITIALIZE_REQUEST);
  });
}

/** Build memento and prove the handshake for each variant the run uses. */
export async function preflightMemento(repoRoot: string, variants: string[]): Promise<void> {
  if (variants.length === 0) return;
  ensureMementoBuilt(repoRoot);
  for (const variant of [...new Set(variants)]) {
    const home = mkdtempSync(join(tmpdir(), 'memento-preflight-'));
    try {
      await probeMcpServer(mementoServer({ repoRoot, mementoHome: home, variant }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}
