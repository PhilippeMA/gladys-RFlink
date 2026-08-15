// -----------------------------------------------------------------------------
// ESLint flat config (ESLint 9+).
//
//   - `@eslint/js` recommended  -> the sensible built-in rule set;
//   - `eslint-config-prettier`  -> turns OFF every stylistic rule so Prettier
//                                  owns formatting and the two never conflict.
// -----------------------------------------------------------------------------

import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/', 'data/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Unused variables are a mistake; allow a leading underscore to mark an
      // argument as intentionally ignored (e.g. `(_gladys, config) => ...`).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Prettier last: it only removes rules, so it must win.
  prettier,
];
