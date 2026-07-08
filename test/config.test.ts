import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, resolveHome, resolveVariantName } from '../src/config.js';

describe('resolveHome', () => {
  test('defaults to ~/.memento when unset', () => {
    expect(resolveHome({})).toBe(join(homedir(), '.memento'));
  });

  test('honours an absolute MEMENTO_HOME override', () => {
    expect(resolveHome({ MEMENTO_HOME: '/custom/path' })).toBe('/custom/path');
  });

  test('expands a leading ~ in the override', () => {
    expect(resolveHome({ MEMENTO_HOME: '~/mem' })).toBe(join(homedir(), 'mem'));
  });

  test('resolves a relative override to an absolute path', () => {
    expect(resolveHome({ MEMENTO_HOME: 'rel/mem' })).toBe(resolve('rel/mem'));
  });
});

describe('resolveVariantName', () => {
  test('defaults to shipped when unset', () => {
    expect(resolveVariantName({})).toBe('shipped');
  });

  test('honours a MEMENTO_VARIANT override', () => {
    expect(resolveVariantName({ MEMENTO_VARIANT: 'plain' })).toBe('plain');
  });

  test('trims surrounding whitespace from an override', () => {
    expect(resolveVariantName({ MEMENTO_VARIANT: '  result-nudges  ' })).toBe('result-nudges');
  });

  test('throws when set but blank, instead of silently defaulting (§10)', () => {
    // A blank value is an env-plumbing bug; falling back to the default silently
    // would poison a harness baseline every knob is paired against.
    expect(() => resolveVariantName({ MEMENTO_VARIANT: '   ' })).toThrow(/set but blank/);
    expect(() => resolveVariantName({ MEMENTO_VARIANT: '' })).toThrow(/set but blank/);
  });
});

describe('loadConfig', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memento-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('returns defaults when no config.json exists', () => {
    const { config } = loadConfig(home);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('derives the standard subpaths from home', () => {
    const { paths } = loadConfig(home);
    expect(paths).toEqual({
      home,
      config: join(home, 'config.json'),
      memories: join(home, 'memories'),
      index: join(home, 'index'),
      logs: join(home, 'logs'),
      dashboard: join(home, 'dashboard'),
    });
  });

  test('merges file overrides over defaults', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ default_result_limit: 3, logging_enabled: false }),
    );
    const { config } = loadConfig(home);
    expect(config.default_result_limit).toBe(3);
    expect(config.logging_enabled).toBe(false);
    expect(config.max_result_limit).toBe(DEFAULT_CONFIG.max_result_limit);
  });

  test('throws on malformed JSON', () => {
    writeFileSync(join(home, 'config.json'), '{ not json');
    expect(() => loadConfig(home)).toThrow(/Invalid config JSON/);
  });

  test('rejects default_result_limit greater than max_result_limit', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ default_result_limit: 20, max_result_limit: 10 }),
    );
    expect(() => loadConfig(home)).toThrow(/must not exceed/);
  });
});
