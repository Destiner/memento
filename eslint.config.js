import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Fixtures are test inputs (often deliberately incomplete), not project code.
    ignores: ['dist/**', 'node_modules/**', 'test-harness/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
