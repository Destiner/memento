import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHistorySource, runCli } from './cli.js';

describe('cloud-only retrospective CLI', () => {
  const temporaryDirectories: string[] = [];
  beforeEach(() => {
    vi.stubEnv('MEMENTO_URL', '');
    vi.stubEnv('MEMENTO_ACCESS_TOKEN', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'memento-retrospective-cli-'));
    temporaryDirectories.push(path);
    return path;
  }

  it('parses explicit client-qualified history sources', () => {
    expect(parseHistorySource('codex:fixtures/history.jsonl')).toMatchObject({
      client: 'codex',
      path: resolve('fixtures/history.jsonl'),
    });
    expect(() => parseHistorySource('history.jsonl')).toThrow(/expected/);
  });

  it('renders help without endpoint, token, or database configuration', async () => {
    const output: string[] = [];
    await runCli(['help'], { stdout: (value) => output.push(value) });
    expect(output.join('\n')).toContain('--data-dir');
    expect(output.join('\n')).toContain('disabled');
  });

  it('requires an explicit evaluation directory, never a default live home', async () => {
    await expect(runCli(['runs'])).rejects.toThrow(/--data-dir is required/);
    await expect(runCli(['runs', '--home', await directory()])).rejects.toThrow(
      /no longer supported/,
    );
  });

  it.each(['promote', 'reconcile-promotion'])(
    'fails %s closed before creating a database or touching memory',
    async (command) => {
      const path = await directory();
      await expect(runCli([command, 'comparison_missing', '--data-dir', path])).rejects.toThrow(
        /disabled.*HTTP/,
      );
      expect(await readdir(path)).toEqual([]);
    },
  );

  it('keeps offline run listing available without cloud configuration', async () => {
    const path = await directory();
    const output: string[] = [];
    await runCli(['runs', '--data-dir', path, '--json'], { stdout: (value) => output.push(value) });
    expect(JSON.parse(output[0]!)).toEqual([]);
    expect(await readdir(path)).toEqual(['retrospective']);
  });

  it('retains the explicit evaluator cost/privacy gate', async () => {
    await expect(runCli(['run', '--data-dir', await directory()])).rejects.toThrow(
      /--allow-remote/,
    );
  });

  it('requires HTTPS remote configuration before starting an evaluator', async () => {
    await expect(
      runCli([
        'run',
        '--data-dir',
        await directory(),
        '--allow-remote',
        '--source',
        'codex:missing.jsonl',
        '--evaluator',
        'codex',
        '--model',
        'offline-test',
      ]),
    ).rejects.toThrow(/MEMENTO_URL|MEMENTO_ACCESS_TOKEN|HTTP Memento connection failed/);
  });

  it('rejects irrelevant review flags', async () => {
    await expect(
      runCli([
        'review',
        'missing',
        'approve',
        '--data-dir',
        await directory(),
        '--actor',
        'test',
        '--label',
        'missed',
      ]),
    ).rejects.toThrow(/Unknown option.*--label/);
  });
});
