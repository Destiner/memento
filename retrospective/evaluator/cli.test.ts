import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  CODEX_ISOLATION_ARGS,
  MAX_EVALUATOR_PROMPT_CHARS,
  ClaudeCodeEvaluator,
  CodexEvaluator,
  evaluatorEnvironment,
  toCodexStrictSchema,
} from './cli.js';
import { captureProposalBatchSchema } from './schema.js';
import type { CommandInvocation, CommandResult, CommandRunner } from './types.js';

const outputSchema = z.object({ answer: z.string() }).strict();

test('preserves supported evaluator authentication without leaking unrelated secrets', () => {
  const environment = evaluatorEnvironment({
    CODEX_API_KEY: 'codex-key',
    CODEX_ACCESS_TOKEN: 'codex-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    UNRELATED_SECRET: 'do-not-pass',
  });

  expect(environment).toMatchObject({
    CODEX_API_KEY: 'codex-key',
    CODEX_ACCESS_TOKEN: 'codex-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
  });
  expect(environment.UNRELATED_SECRET).toBeUndefined();
});

class FakeRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];

  constructor(
    private readonly respond: (invocation: CommandInvocation) => Promise<CommandResult>,
  ) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    return this.respond(invocation);
  }
}

describe('ClaudeCodeEvaluator', () => {
  test('uses safe, tool-disabled, non-persistent structured output', async () => {
    const runner = new FakeRunner(async () => ({
      stdout: JSON.stringify({ structured_output: { answer: 'ok' } }),
      stderr: '',
      exitCode: 0,
    }));
    const evaluator = new ClaudeCodeEvaluator({
      model: 'claude-opus-test',
      runner,
      cliVersion: '2.1.220',
    });

    const result = await evaluator.evaluate({
      prompt: 'Evaluate redacted context.',
      promptVersion: 'search-1',
      schemaVersion: '1',
      outputSchema,
    });

    expect(result.output).toEqual({ answer: 'ok' });
    expect(result.run).toMatchObject({
      provider: 'claude-code',
      cli: 'claude',
      cliVersion: '2.1.220',
      model: 'claude-opus-test',
      promptVersion: 'search-1',
      schemaVersion: '1',
    });
    const invocation = runner.invocations[0];
    expect(invocation?.args).toContain('--safe-mode');
    expect(invocation?.args).toContain('--no-session-persistence');
    expect(invocation?.args).toContain('--json-schema');
    expect(invocation?.args).toContain('--input-format');
    expect(invocation?.args).not.toContain('Evaluate redacted context.');
    expect(invocation?.stdin).toBe('Evaluate redacted context.');
    expect(
      invocation?.args.slice(
        invocation.args.indexOf('--tools'),
        invocation.args.indexOf('--tools') + 2,
      ),
    ).toEqual(['--tools', '']);
  });

  test('validates the model response instead of trusting CLI success', async () => {
    const runner = new FakeRunner(async () => ({
      stdout: JSON.stringify({ structured_output: { answer: 42 } }),
      stderr: '',
      exitCode: 0,
    }));
    const evaluator = new ClaudeCodeEvaluator({
      model: 'claude-test',
      runner,
      cliVersion: '1.0.0',
    });
    await expect(
      evaluator.evaluate({ prompt: 'p', promptVersion: '1', schemaVersion: '1', outputSchema }),
    ).rejects.toThrow();
  });
});

describe('CodexEvaluator', () => {
  test('is ephemeral, ignores config, uses read-only sandbox and an empty cwd', async () => {
    let cwdEntries: string[] = [];
    const runner = new FakeRunner(async (invocation) => {
      cwdEntries = await readdir(invocation.cwd);
      return {
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) },
          }),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    });
    const evaluator = new CodexEvaluator({
      model: 'gpt-5.6-test',
      runner,
      cliVersion: '0.145.0',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/evaluator',
        OPENAI_API_KEY: 'required-auth',
        MEMENTO_HOME: '/private/store',
        UNRELATED_SECRET: 'must-not-leak',
      },
    });

    const result = await evaluator.evaluate({
      prompt: 'Evaluate redacted context.',
      promptVersion: 'capture-1',
      schemaVersion: '1',
      outputSchema,
    });

    expect(result.output).toEqual({ answer: 'ok' });
    expect(cwdEntries).toEqual([]);
    const invocation = runner.invocations[0];
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        'shell_environment_policy.inherit="none"',
        'approval_policy="never"',
        'web_search="disabled"',
        '--sandbox',
        'read-only',
        '--output-schema',
      ]),
    );
    expect(invocation?.stdin).toBe('Evaluate redacted context.');
    expect(invocation?.args.at(-1)).toBe('-');
    expect(disabledFeatures(invocation?.args ?? [])).toEqual(
      expect.arrayContaining([
        'shell_tool',
        'unified_exec',
        'shell_snapshot',
        'apps',
        'auth_elicitation',
        'plugins',
        'plugin_sharing',
        'remote_plugin',
        'multi_agent',
        'goals',
        'hooks',
        'guardian_approval',
        'browser_use',
        'browser_use_external',
        'browser_use_full_cdp_access',
        'in_app_browser',
        'computer_use',
        'image_generation',
        'skill_search',
        'skill_mcp_dependency_install',
        'tool_call_mcp_elicitation',
        'tool_suggest',
        'workspace_dependencies',
        'code_mode_host',
      ]),
    );
    expect(invocation?.env.OPENAI_API_KEY).toBe('required-auth');
    expect(invocation?.env.MEMENTO_HOME).toBeUndefined();
    expect(invocation?.env.UNRELATED_SECRET).toBeUndefined();
    expect(result.run.cliVersion).toBe('0.145.0');
  });

  test('detects and records the CLI version through the injected runner', async () => {
    const runner = new FakeRunner(async (invocation) => {
      if (invocation.args[0] === '--version') {
        return { stdout: 'codex-cli 0.145.0\n', stderr: '', exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify({ answer: 'ok' }) },
        }),
        stderr: '',
        exitCode: 0,
      };
    });
    const evaluator = new CodexEvaluator({ model: 'gpt-test', runner });
    const result = await evaluator.evaluate({
      prompt: 'p',
      promptVersion: '1',
      schemaVersion: '1',
      outputSchema,
    });
    expect(result.run.cliVersion).toBe('0.145.0');
    expect(runner.invocations.some((invocation) => invocation.args[0] === '--version')).toBe(true);
  });

  test('converts optional and union schemas to Codex strict structured output', async () => {
    const original = z.toJSONSchema(captureProposalBatchSchema, { target: 'draft-07' });
    const strict = toCodexStrictSchema(original);
    expect(JSON.stringify(strict)).not.toContain('"oneOf"');
    expectAllPropertiesRequired(strict);

    const optionalOutputSchema = z
      .object({ answer: z.string(), detail: z.string().optional() })
      .strict();
    let writtenSchema: unknown;
    const runner = new FakeRunner(async (invocation) => {
      const schemaPath = invocation.args[invocation.args.indexOf('--output-schema') + 1]!;
      writtenSchema = JSON.parse(await readFile(schemaPath, 'utf8')) as unknown;
      return {
        stdout: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({ answer: 'ok', detail: null }),
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    });
    const evaluator = new CodexEvaluator({
      model: 'gpt-test',
      runner,
      cliVersion: '0.145.0',
    });

    const result = await evaluator.evaluate({
      prompt: 'p',
      promptVersion: '1',
      schemaVersion: '1',
      outputSchema: optionalOutputSchema,
    });

    expect(result.output).toEqual({ answer: 'ok' });
    expect(writtenSchema).toMatchObject({ required: ['answer', 'detail'] });
  });

  test.runIf(spawnSync('codex', ['--version']).status === 0)(
    'uses isolation flags accepted by the installed Codex strict config parser',
    () => {
      const missingSchema = join(
        tmpdir(),
        `memento-retrospective-missing-schema-${process.pid}.json`,
      );
      const result = spawnSync(
        'codex',
        ['exec', '--json', ...CODEX_ISOLATION_ARGS, '--output-schema', missingSchema, '-'],
        { encoding: 'utf8', input: 'x' },
      );
      const diagnostic = `${result.stdout}\n${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(diagnostic).not.toMatch(/unknown configuration field|Error loading config\.toml/);
      expect(diagnostic).toMatch(/schema/i);
    },
  );

  test('rejects oversized prompts before invoking the CLI', async () => {
    const runner = new FakeRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const evaluator = new CodexEvaluator({ model: 'gpt-test', runner, cliVersion: '0.145.0' });
    await expect(
      evaluator.evaluate({
        prompt: 'x'.repeat(MAX_EVALUATOR_PROMPT_CHARS + 1),
        promptVersion: '1',
        schemaVersion: '1',
        outputSchema,
      }),
    ).rejects.toThrow('evaluator prompt must contain');
    expect(runner.invocations).toEqual([]);
  });
});

function disabledFeatures(args: string[]): string[] {
  return args.flatMap((argument, index) => (argument === '--disable' ? [args[index + 1]!] : []));
}

function expectAllPropertiesRequired(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) expectAllPropertiesRequired(entry);
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  const record = schema as Record<string, unknown>;
  if (record.type === 'object' && record.properties && typeof record.properties === 'object') {
    expect(record.required).toEqual(Object.keys(record.properties as Record<string, unknown>));
  }
  for (const value of Object.values(record)) expectAllPropertiesRequired(value);
}
