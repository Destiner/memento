import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openIndex } from '../../src/store/index-open.js';
import { INDEX_SCHEMA_VERSION } from '../../src/store/index-schema.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/memories', import.meta.url));

describe('openIndex', () => {
  let home: string;
  let indexDir: string;
  let memoriesDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memento-open-'));
    indexDir = join(home, 'index');
    memoriesDir = join(home, 'memories');
    cpSync(FIXTURES, memoriesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('builds and stamps the index on first open', async () => {
    const { index, rebuilt, rebuild } = await openIndex({ indexDir, memoriesDir });

    expect(rebuilt).toBe(true);
    expect(rebuild?.indexed).toBe(3);
    expect(index.count()).toBe(3);

    const stamped = JSON.parse(readFileSync(join(indexDir, 'schema_version.json'), 'utf8'));
    expect(stamped.schema_version).toBe(INDEX_SCHEMA_VERSION);
    index.close();
  });

  test('reuses a current index without rebuilding', async () => {
    const first = await openIndex({ indexDir, memoriesDir });
    first.index.close();

    const second = await openIndex({ indexDir, memoriesDir });
    expect(second.rebuilt).toBe(false);
    expect(second.index.count()).toBe(3);
    second.index.close();
  });

  test('rebuilds when the recorded schema version is stale', async () => {
    const first = await openIndex({ indexDir, memoriesDir });
    first.index.close();
    writeFileSync(
      join(indexDir, 'schema_version.json'),
      JSON.stringify({ schema_version: INDEX_SCHEMA_VERSION + 1 }),
    );

    const second = await openIndex({ indexDir, memoriesDir });
    expect(second.rebuilt).toBe(true);
    expect(second.index.count()).toBe(3);
    second.index.close();
  });

  test('rebuilds when the version stamp is missing', async () => {
    const first = await openIndex({ indexDir, memoriesDir });
    first.index.close();
    rmSync(join(indexDir, 'schema_version.json'), { force: true });

    const second = await openIndex({ indexDir, memoriesDir });
    expect(second.rebuilt).toBe(true);
    second.index.close();
  });
});
