import { describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { validateFrontmatter } from '../../src/store/schema.js';

const validMetadata = {
  id: 'mem_01JEXAMPLE000000000',
  title: 'Legacy sync service: current product role',
  type: 'product_context',
  scope: 'cross_project',
  status: 'active',
  created_at: '2026-07-04T15:00:00Z',
  updated_at: '2026-07-04T15:00:00Z',
  projects: ['legacy-sync', 'customer-portal'],
  tags: ['migration'],
  confidence: 'high',
  importance: 'high',
  review_after: '2026-10-01',
  source_kind: 'observed',
};

describe('validateFrontmatter', () => {
  test('accepts a well-formed record and returns it typed', () => {
    expect(validateFrontmatter(validMetadata)).toEqual(validMetadata);
  });

  test('accepts the minimal required-only record', () => {
    const minimal = {
      id: 'mem_1',
      title: 'T',
      type: 'decision',
      scope: 'project',
      status: 'active',
      created_at: '2026-07-04T15:00:00Z',
      updated_at: '2026-07-04T15:00:00Z',
    };
    expect(validateFrontmatter(minimal)).toEqual(minimal);
  });

  test('rejects an out-of-vocabulary type', () => {
    expect(() => validateFrontmatter({ ...validMetadata, type: 'random' })).toThrow(MementoError);
  });

  test('reports every offending vocabulary field', () => {
    try {
      validateFrontmatter({ ...validMetadata, scope: 'nope', confidence: 'certain' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MementoError);
      const details = (error as MementoError).details as { path: string }[];
      expect(details.map((d) => d.path).sort()).toEqual(['/confidence', '/scope']);
    }
  });

  test('rejects a malformed review_after date', () => {
    expect(() => validateFrontmatter({ ...validMetadata, review_after: '2026' })).toThrow(
      MementoError,
    );
  });

  test('rejects unknown front-matter keys', () => {
    expect(() => validateFrontmatter({ ...validMetadata, mystery: true })).toThrow(MementoError);
  });
});
