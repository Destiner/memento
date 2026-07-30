import { describe, expect, test } from 'vitest';

import { makeAdapter, mcpConfigToToml, parseCodexResult } from './harness.js';

// Verbatim events from a real `codex exec --json` probe (codex-cli 0.145.0).
const CODEX_JSONL = [
  '{"type": "thread.started", "thread_id": "019fb502-ff5b-7ed1-a521-10cf1ca0434d"}',
  '{"type": "turn.started"}',
  '{"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "done"}}',
  '{"type": "turn.completed", "usage": {"input_tokens": 16023, "cached_input_tokens": 0, "cache_write_input_tokens": 0, "output_tokens": 89, "reasoning_output_tokens": 65}}',
].join('\n');

describe('codex adapter', () => {
  const codex = makeAdapter('codex');

  test('builds a codex exec invocation with CODEX_HOME isolation', () => {
    const inv = codex.buildInvocation({
      repoDir: '/sandbox/repo',
      configHome: '/sandbox/codex-home',
      mcpConfigPath: '/sandbox/codex-home/config.toml',
      task: 'Fix the bug.',
      model: 'gpt-5.6-sol',
    });
    expect(inv.command).toBe('codex');
    expect(inv.args).toEqual([
      'exec',
      '--json',
      '-m',
      'gpt-5.6-sol',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      'Fix the bug.',
    ]);
    expect(inv.env.CODEX_HOME).toBe('/sandbox/codex-home');
    expect(inv.cwd).toBe('/sandbox/repo');
  });

  test('parses JSONL events: usage, turns, session id, final message', () => {
    const r = parseCodexResult(CODEX_JSONL);
    expect(r.parsed).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.tokensIn).toBe(16023);
    expect(r.tokensOut).toBe(89); // output_tokens already includes reasoning
    expect(r.turns).toBe(1);
    expect(r.sessionId).toBe('019fb502-ff5b-7ed1-a521-10cf1ca0434d');
    expect(r.resultText).toBe('done');
    expect(r.costUsd).toBeNull(); // codex reports no dollar cost
  });

  test('a stream without a final agent message is an error', () => {
    const r = parseCodexResult('{"type": "turn.started"}');
    expect(r.parsed).toBe(true);
    expect(r.isError).toBe(true);
  });

  test('garbage output is unparsed (invalid rep), non-JSON lines are skipped', () => {
    expect(parseCodexResult('').parsed).toBe(false);
    expect(parseCodexResult('SIGKILL noise\n').parsed).toBe(false);
    const mixed = parseCodexResult('starting up...\n' + CODEX_JSONL);
    expect(mixed.parsed).toBe(true);
    expect(mixed.resultText).toBe('done');
  });

  test('costReported=false so the spend cap charges the fallback by design', () => {
    expect(codex.costReported).toBe(false);
    expect(codex.supportsHooks).toBe(false);
    expect(codex.instructionsFile).toBe('AGENTS.md');
  });
});

describe('mcpConfigToToml', () => {
  test('renders [mcp_servers.*] tables with command/args/env', () => {
    const toml = mcpConfigToToml({
      mcpServers: {
        memento: {
          command: 'node',
          args: ['/repo/dist/main.js'],
          env: { MEMENTO_HOME: '/tmp/home', MEMENTO_VARIANT: 'plain' },
        },
        tracker: { command: 'bun', args: ['run', '/stubs/server.ts'] },
      },
    });
    expect(toml).toContain('[mcp_servers.memento]');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/repo/dist/main.js"]');
    expect(toml).toContain('env = { MEMENTO_HOME = "/tmp/home", MEMENTO_VARIANT = "plain" }');
    expect(toml).toContain('[mcp_servers.tracker]');
    expect(toml).not.toContain('env = { }');
  });
});

describe('claude-code adapter', () => {
  test('delegates to the claude -p invocation shape', () => {
    const cc = makeAdapter('claude-code');
    const inv = cc.buildInvocation({
      repoDir: '/r',
      configHome: '/h',
      mcpConfigPath: '/m.json',
      task: 't',
      model: 'claude-opus-4-8',
    });
    expect(inv.command).toBe('claude');
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe('/h');
    expect(cc.instructionsFile).toBe('CLAUDE.md');
    expect(cc.supportsHooks).toBe(true);
    expect(cc.costReported).toBe(true);
  });
});
