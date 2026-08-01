import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { POLICY_VERSION } from '../../src/policy/index.js';
import { evaluatorRunSchema } from './schema.js';
import { NodeCommandRunner } from './runner.js';
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
  EvaluationRequest,
  EvaluationResult,
  Evaluator,
  EvaluatorRuntimeIdentity,
} from './types.js';

export interface CliEvaluatorOptions {
  model: string;
  runner?: CommandRunner;
  cliVersion?: string;
  env?: NodeJS.ProcessEnv;
  tempDirectory?: string;
}

export const MAX_EVALUATOR_PROMPT_CHARS = 300_000;

abstract class CliEvaluator implements Evaluator {
  abstract readonly provider: 'claude-code' | 'codex';
  abstract readonly cli: 'claude' | 'codex';
  readonly model: string;
  private readonly runner: CommandRunner;
  private readonly configuredCliVersion: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tempDirectory: string;
  private versionPromise: Promise<string> | undefined;

  constructor(options: CliEvaluatorOptions) {
    this.model = options.model;
    this.runner = options.runner ?? new NodeCommandRunner();
    this.configuredCliVersion = options.cliVersion;
    this.env = evaluatorEnvironment(options.env ?? process.env);
    this.tempDirectory = options.tempDirectory ?? tmpdir();
  }

  async identity(): Promise<EvaluatorRuntimeIdentity> {
    return {
      provider: this.provider,
      cli: this.cli,
      cliVersion: await this.cliVersion(this.tempDirectory),
      model: this.model,
    };
  }

  async evaluate<Output>(request: EvaluationRequest<Output>): Promise<EvaluationResult<Output>> {
    if (request.prompt.length === 0 || request.prompt.length > MAX_EVALUATOR_PROMPT_CHARS) {
      throw new Error(
        `evaluator prompt must contain 1-${MAX_EVALUATOR_PROMPT_CHARS} characters; received ` +
          request.prompt.length,
      );
    }
    const root = await mkdtemp(join(this.tempDirectory, 'memento-retrospective-'));
    const cwd = join(root, 'work');
    await mkdir(cwd);
    try {
      const jsonSchema = z.toJSONSchema(request.outputSchema, { target: 'draft-07' });
      const invocation = await this.invocation(
        request.prompt,
        this.prepareOutputSchema(jsonSchema),
        root,
        cwd,
      );
      const [result, identity] = await Promise.all([this.runner.run(invocation), this.identity()]);
      assertCommandSucceeded(this.cli, result);
      const unvalidated = this.normalizeOutput(this.parseOutput(result.stdout), jsonSchema);
      const output = request.outputSchema.parse(unvalidated);
      const run = evaluatorRunSchema.parse({
        provider: this.provider,
        cli: this.cli,
        cliVersion: identity.cliVersion,
        model: this.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        policyVersion: POLICY_VERSION,
      });
      return { output, run };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  protected environment(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  protected prepareOutputSchema(jsonSchema: unknown): unknown {
    return jsonSchema;
  }

  protected normalizeOutput(output: unknown, originalSchema: unknown): unknown {
    void originalSchema;
    return output;
  }

  protected abstract invocation(
    prompt: string,
    jsonSchema: unknown,
    root: string,
    cwd: string,
  ): Promise<CommandInvocation>;

  protected abstract parseOutput(stdout: string): unknown;

  private async cliVersion(cwd: string): Promise<string> {
    if (this.configuredCliVersion !== undefined) return this.configuredCliVersion;
    this.versionPromise ??= this.runner
      .run({ command: this.cli, args: ['--version'], cwd, env: this.environment() })
      .then((result) => {
        assertCommandSucceeded(this.cli, result);
        const raw = result.stdout.trim();
        return /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(raw)?.[0] ?? raw;
      });
    return this.versionPromise;
  }
}

export class ClaudeCodeEvaluator extends CliEvaluator {
  readonly provider = 'claude-code' as const;
  readonly cli = 'claude' as const;

  protected async invocation(
    prompt: string,
    jsonSchema: unknown,
    _root: string,
    cwd: string,
  ): Promise<CommandInvocation> {
    return {
      command: this.cli,
      args: [
        '--print',
        '--safe-mode',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--input-format',
        'text',
        '--permission-mode',
        'plan',
        '--tools',
        '',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(jsonSchema),
        '--model',
        this.model,
      ],
      cwd,
      env: this.environment(),
      stdin: prompt,
    };
  }

  protected parseOutput(stdout: string): unknown {
    const envelope = parseJson(stdout);
    if (isObject(envelope) && envelope.structured_output !== undefined) {
      return envelope.structured_output;
    }
    if (isObject(envelope) && typeof envelope.result === 'string') {
      return parseJson(envelope.result);
    }
    return envelope;
  }
}

export const CODEX_ISOLATION_ARGS = [
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
  '-c',
  'shell_environment_policy.inherit="none"',
  '-c',
  'approval_policy="never"',
  '-c',
  'web_search="disabled"',
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'shell_snapshot',
  '--disable',
  'apps',
  '--disable',
  'auth_elicitation',
  '--disable',
  'plugins',
  '--disable',
  'plugin_sharing',
  '--disable',
  'remote_plugin',
  '--disable',
  'multi_agent',
  '--disable',
  'goals',
  '--disable',
  'hooks',
  '--disable',
  'guardian_approval',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'browser_use_full_cdp_access',
  '--disable',
  'in_app_browser',
  '--disable',
  'computer_use',
  '--disable',
  'image_generation',
  '--disable',
  'skill_search',
  '--disable',
  'skill_mcp_dependency_install',
  '--disable',
  'tool_call_mcp_elicitation',
  '--disable',
  'tool_suggest',
  '--disable',
  'workspace_dependencies',
  '--disable',
  'code_mode_host',
  '--sandbox',
  'read-only',
  '--skip-git-repo-check',
] as const;

export class CodexEvaluator extends CliEvaluator {
  readonly provider = 'codex' as const;
  readonly cli = 'codex' as const;

  protected override prepareOutputSchema(jsonSchema: unknown): unknown {
    return toCodexStrictSchema(jsonSchema);
  }

  protected override normalizeOutput(output: unknown, originalSchema: unknown): unknown {
    return stripOptionalNulls(output, originalSchema);
  }

  protected async invocation(
    prompt: string,
    jsonSchema: unknown,
    root: string,
    cwd: string,
  ): Promise<CommandInvocation> {
    const schemaPath = join(root, 'output-schema.json');
    await writeFile(schemaPath, JSON.stringify(jsonSchema));
    return {
      command: this.cli,
      args: [
        'exec',
        '--json',
        ...CODEX_ISOLATION_ARGS,
        '--output-schema',
        schemaPath,
        '--model',
        this.model,
        '-',
      ],
      cwd,
      env: this.environment(),
      stdin: prompt,
    };
  }

  protected parseOutput(stdout: string): unknown {
    let finalMessage: string | undefined;
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue;
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isObject(event) || event.type !== 'item.completed' || !isObject(event.item)) continue;
      if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
        finalMessage = event.item.text;
      }
    }
    if (finalMessage === undefined) throw new Error('codex produced no final agent message');
    return parseJson(finalMessage);
  }
}

function assertCommandSucceeded(cli: string, result: CommandResult): void {
  if (result.exitCode === 0 && result.timedOut !== true && result.outputLimitExceeded !== true) {
    return;
  }
  const detail = result.stderr.trim().slice(-2_000);
  throw new Error(
    `${cli} evaluator failed${result.timedOut === true ? ' (timed out)' : ''}` +
      `${result.outputLimitExceeded === true ? ' (output limit exceeded)' : ''} with exit ` +
      `${result.exitCode ?? 'unknown'}${detail === '' ? '' : `: ${detail}`}`,
  );
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);
const SAFE_ENVIRONMENT_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'AWS_', 'AZURE_OPENAI_'];

export function evaluatorEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT_KEYS.has(key) ||
          SAFE_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))),
    ),
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value.trim()) as unknown;
  } catch (error) {
    throw new Error(`evaluator returned invalid JSON: ${String(error)}`);
  }
}

export function toCodexStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toCodexStrictSchema);
  if (!isObject(schema)) return schema;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    const normalizedKey = key === 'oneOf' ? 'anyOf' : key;
    const transformed = toCodexStrictSchema(value);
    if (normalizedKey === 'anyOf' && Array.isArray(output.anyOf) && Array.isArray(transformed)) {
      output.anyOf = [...output.anyOf, ...transformed];
    } else {
      output[normalizedKey] = transformed;
    }
  }
  if (Array.isArray(output.anyOf)) {
    output.anyOf = output.anyOf.flatMap((branch) =>
      isObject(branch) && Object.keys(branch).length === 1 && Array.isArray(branch.anyOf)
        ? branch.anyOf
        : [branch],
    );
  }

  if (output.type !== 'object' || !isObject(output.properties)) return output;
  const originallyRequired = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output.properties)) {
    properties[key] = originallyRequired.has(key) ? value : allowNull(value);
  }
  output.properties = properties;
  output.required = Object.keys(properties);
  return output;
}

function allowNull(schema: unknown): unknown {
  if (allowsNull(schema)) return schema;
  return { anyOf: [schema, { type: 'null' }] };
}

function allowsNull(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  if (schema.type === 'null') return true;
  return ['anyOf', 'oneOf'].some(
    (key) => Array.isArray(schema[key]) && schema[key].some((branch) => allowsNull(branch)),
  );
}

function stripOptionalNulls(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) {
    const itemSchema = isObject(schema) ? schema.items : undefined;
    return value.map((entry) => stripOptionalNulls(entry, itemSchema));
  }
  if (!isObject(value)) return value;

  const objectSchema = selectObjectSchema(schema, value);
  const properties = isObject(objectSchema?.properties) ? objectSchema.properties : {};
  const required = new Set(
    Array.isArray(objectSchema?.required)
      ? objectSchema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (entry === null && key in properties && !required.has(key)) return [];
      return [[key, stripOptionalNulls(entry, properties[key])]];
    }),
  );
}

function selectObjectSchema(
  schema: unknown,
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isObject(schema)) return undefined;
  if (schema.type === 'object' && isObject(schema.properties)) return schema;
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[key])) continue;
    const candidates = schema[key]
      .map((branch) => selectObjectSchema(branch, value))
      .filter((branch) => branch !== undefined);
    return candidates.find((candidate) => constantsMatch(candidate, value)) ?? candidates[0];
  }
  return undefined;
}

function constantsMatch(schema: Record<string, unknown>, value: Record<string, unknown>): boolean {
  if (!isObject(schema.properties)) return true;
  return Object.entries(schema.properties).every((entry) => {
    const [key, propertySchema] = entry;
    return (
      !isObject(propertySchema) ||
      !('const' in propertySchema) ||
      value[key] === propertySchema.const
    );
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
