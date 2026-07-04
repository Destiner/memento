// Configuration loading and home-directory resolution.
//
// The memory home defaults to ~/.agent-memory and can be overridden with the
// AGENT_MEMORY_HOME environment variable. A config.json in the home directory
// overrides individual defaults. Loading is read-only: nothing is created here —
// directory scaffolding belongs to the store and report tooling. Full schema
// validation lives in the validation helper (a later task); this module only
// applies light guards to keep the merged config internally consistent.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MementoConfig {
  schema_version: number;
  search_backend: 'fts5';
  default_result_limit: number;
  max_result_limit: number;
  logging_enabled: boolean;
}

export interface MementoPaths {
  home: string;
  config: string;
  memories: string;
  index: string;
  logs: string;
  dashboard: string;
}

export interface ResolvedConfig {
  paths: MementoPaths;
  config: MementoConfig;
}

export const DEFAULT_HOME_DIR = '.agent-memory';

export const DEFAULT_CONFIG: MementoConfig = {
  schema_version: 1,
  search_backend: 'fts5',
  default_result_limit: 5,
  max_result_limit: 10,
  logging_enabled: true,
};

/** Resolve the memory home directory, honouring AGENT_MEMORY_HOME. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_MEMORY_HOME?.trim();
  if (override) {
    return resolve(expandTilde(override));
  }
  return join(homedir(), DEFAULT_HOME_DIR);
}

/** Derive the standard subpaths (§6 layout) from a home directory. */
export function resolvePaths(home: string): MementoPaths {
  return {
    home,
    config: join(home, 'config.json'),
    memories: join(home, 'memories'),
    index: join(home, 'index'),
    logs: join(home, 'logs'),
    dashboard: join(home, 'dashboard'),
  };
}

/**
 * Load the effective config for a home directory. Missing config.json yields
 * pure defaults; a present file overrides individual fields. Read-only.
 */
export function loadConfig(home: string = resolveHome()): ResolvedConfig {
  const paths = resolvePaths(home);
  const config = mergeConfig(DEFAULT_CONFIG, readConfigFile(paths.config));
  return { paths, config };
}

function expandTilde(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function readConfigFile(path: string): Partial<MementoConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid config JSON at ${path}: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config at ${path} must be a JSON object.`);
  }
  return parsed as Partial<MementoConfig>;
}

function mergeConfig(base: MementoConfig, overrides: Partial<MementoConfig>): MementoConfig {
  const merged: MementoConfig = { ...base, ...overrides };

  assertPositiveInt(merged, 'schema_version');
  assertPositiveInt(merged, 'default_result_limit');
  assertPositiveInt(merged, 'max_result_limit');

  if (merged.default_result_limit > merged.max_result_limit) {
    throw new Error(
      `default_result_limit (${merged.default_result_limit}) must not exceed max_result_limit (${merged.max_result_limit}).`,
    );
  }
  if (typeof merged.logging_enabled !== 'boolean') {
    throw new Error(`logging_enabled must be a boolean, got ${typeof merged.logging_enabled}.`);
  }

  return merged;
}

function assertPositiveInt(
  config: MementoConfig,
  key: 'schema_version' | 'default_result_limit' | 'max_result_limit',
): void {
  const value = config[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(value)}.`);
  }
}
