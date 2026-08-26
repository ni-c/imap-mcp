// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain-JavaScript build scripts. The TypeScript sources get `process` and
    // `console` from tsconfig's "types": ["node"]; a .mjs file has no such
    // declaration, so the globals are named here instead of pulling in the
    // whole `globals` package for two of them.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  }
);
