import { describe, expect, test } from 'vitest';

import { buildClaudeInvocation, parseSessionResult } from './session.js';

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
