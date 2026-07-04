import { expect, test } from 'vitest';

import { name } from '../src/index.js';

test('package exposes its name', () => {
  expect(name).toBe('memento');
});
