import { describe, expect, test } from 'vitest';

import { MementoError, toErrorShape } from '../src/errors.js';

describe('MementoError', () => {
  test('carries code and message', () => {
    const err = new MementoError('not_found', 'no such memory');
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('no such memory');
    expect(err).toBeInstanceOf(Error);
  });

  test('omits details from the shape when absent', () => {
    const shape = new MementoError('invalid_request', 'bad').toShape();
    expect(shape).toEqual({ code: 'invalid_request', message: 'bad' });
    expect('details' in shape).toBe(false);
  });

  test('includes details in the shape when present', () => {
    const shape = new MementoError('validation_error', 'bad', [{ path: '/x' }]).toShape();
    expect(shape).toEqual({
      code: 'validation_error',
      message: 'bad',
      details: [{ path: '/x' }],
    });
  });
});

describe('toErrorShape', () => {
  test('preserves a MementoError verbatim', () => {
    const err = new MementoError('version_conflict', 'stale', { expected: 1 });
    expect(toErrorShape(err)).toEqual({
      code: 'version_conflict',
      message: 'stale',
      details: { expected: 1 },
    });
  });

  test('collapses an unknown Error to internal_error', () => {
    expect(toErrorShape(new Error('boom'))).toEqual({
      code: 'internal_error',
      message: 'boom',
    });
  });

  test('stringifies a non-Error throw', () => {
    expect(toErrorShape('nope')).toEqual({ code: 'internal_error', message: 'nope' });
  });
});
