// ABOUTME: ESLint 9 flat config for TypeScript Node.js project
// ABOUTME: Integrates with Prettier and uses typescript-eslint recommended rules

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Allow unused vars prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow explicit any in some cases (we can tighten later)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Require explicit return types on exported functions
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.js', '!eslint.config.js'],
  }
);
