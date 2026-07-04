import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { MementoError } from '../src/errors.js';
import { validate } from '../src/validation.js';

const schema = z.object({
  title: z.string().min(1),
  count: z.number().int(),
  nested: z.object({ flag: z.boolean() }),
});

describe('validate', () => {
  test('returns typed data on success', () => {
    const input = { title: 'ok', count: 2, nested: { flag: true } };
    expect(validate(schema, input)).toEqual(input);
  });

  test('throws a validation_error on failure', () => {
    expect(() => validate(schema, { title: '', count: 1.5, nested: { flag: 1 } })).toThrow(
      MementoError,
    );
  });

  test('reports each offending field with a rooted path', () => {
    try {
      validate(schema, { title: '', count: 1.5, nested: { flag: 'x' } });
      expect.unreachable('expected validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MementoError);
      const err = error as MementoError;
      expect(err.code).toBe('validation_error');
      const paths = (err.details as { path: string }[]).map((d) => d.path);
      expect(paths).toContain('/title');
      expect(paths).toContain('/count');
      expect(paths).toContain('/nested/flag');
    }
  });

  test('uses "/" as the path for a root-level failure', () => {
    try {
      validate(z.string(), 42);
      expect.unreachable('expected validation to throw');
    } catch (error) {
      const err = error as MementoError;
      expect((err.details as { path: string }[])[0]?.path).toBe('/');
    }
  });
});
