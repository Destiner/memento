import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { validateMemoryFrontmatter } from '../../src/store/memory-schema.js';
import { HARNESS_PROJECT_ID } from './sandbox.js';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('V2 corpus', () => {
  test('every seeded memory uses the production V2 schema and harness project id', () => {
    const dirs = [
      join(HARNESS_ROOT, 'corpus', 'standard-15'),
      join(HARNESS_ROOT, 'corpus', 'facts'),
    ];
    let count = 0;
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
        const { metadata, body } = parseFrontmatter(readFileSync(join(dir, name), 'utf8'));
        const memory = validateMemoryFrontmatter(metadata);
        expect(body.trim(), name).not.toBe('');
        expect(memory.scope, name).toEqual({
          kind: 'projects',
          project_ids: [HARNESS_PROJECT_ID],
        });
        count++;
      }
    }
    expect(count).toBe(19);
  });
});
