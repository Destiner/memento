// Run preflight (§7.2): prove the memento MCP server actually boots and answers
// an `initialize` handshake for every variant the run uses, BEFORE any paid
// session launches. A server that dies at startup is invisible downstream —
// Claude Code reports it as "connecting", the model never sees the tools, and
// every rep records zero memento calls, which reads exactly like "the model
// chose not to use memory." A dead server must abort the run loudly, not
// fabricate a behavioral result.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { readMementoCalls } from './event-log.js';
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

/**
 * Bundle the memento server into a single self-contained file in a neutral temp
 * dir and return its path. Reps launch THIS file, not the dev checkout's dist/:
 * the server path in the rep's MCP config is a breadcrumb an exploring agent
 * will follow, and dist/main.js led codex sessions straight to the harness repo
 * — scenario definitions, answer regexes, corpus sources (§7.2 isolation).
 */
export function bundleMementoServer(repoRoot: string): string {
  const out = join(mkdtempSync(join(tmpdir(), 'mcp-server-')), 'server.js');
  execFileSync(
    'bun',
    ['build', join(repoRoot, 'src', 'main.ts'), '--target=node', `--outfile=${out}`],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  return out;
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

/**
 * Exercise one real V2 tool through the bundled stdio server and verify that the
 * server's own event log observed it. A handshake alone cannot distinguish a
 * usable tool path from a server that initializes and then rejects every call.
 */
export async function probeMementoTool(
  spec: McpServerSpec,
  mementoHome: string,
  timeoutMs = 10_000,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...getDefaultEnvironment(), ...spec.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'memento-harness-preflight', version: '0' });
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'MCP tool preflight initialize');
    const tools = await withTimeout(client.listTools(), timeoutMs, 'MCP tool preflight listTools');
    if (!tools.tools.some((tool) => tool.name === 'resolve_project')) {
      throw new Error('MCP tool preflight failed: resolve_project is not registered.');
    }
    const result = await withTimeout(
      client.callTool({ name: 'resolve_project', arguments: { name_hint: 'preflight-missing' } }),
      timeoutMs,
      'MCP tool preflight resolve_project',
    );
    if (result.isError) {
      throw new Error(`MCP tool preflight failed: ${JSON.stringify(result.content)}`);
    }
    await waitForLoggedCall(mementoHome, timeoutMs);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForLoggedCall(mementoHome: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readMementoCalls(mementoHome).some((call) => call.tool === 'resolve_project')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('MCP tool preflight failed: resolve_project was absent from the event log.');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bundle memento and prove the handshake for each variant the run uses, probing
 * the same bundle the reps will launch. Returns the bundle path ('' when the run
 * registers no memento at all).
 */
export async function preflightMemento(repoRoot: string, variants: string[]): Promise<string> {
  if (variants.length === 0) return '';
  const serverEntry = bundleMementoServer(repoRoot);
  for (const variant of [...new Set(variants)]) {
    const home = mkdtempSync(join(tmpdir(), 'memento-preflight-'));
    try {
      const spec = mementoServer({ serverEntry, mementoHome: home, variant });
      await probeMcpServer(spec);
      await probeMementoTool(spec, home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  return serverEntry;
}
