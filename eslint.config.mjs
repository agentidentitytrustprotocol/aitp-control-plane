import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'drizzle/**', 'coverage/**', 'next-env.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    // The `var __foo` pattern inside `declare global` blocks lints clean
    // without explicit disable comments, but those comments stay in the
    // code as documentation. Suppress "unused disable" warnings so the
    // legitimate ones still report normally.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Pino is the only path to log output. Direct console.* in non-test
      // code bypasses log levels, structured fields, and the request-id
      // correlation that callers expect to find in logs.
      'no-console': 'error',
      // The `declare global { var __foo: ... }` pattern is required to
      // type-check process-wide singletons stored on globalThis (eventBus,
      // logger, db pool, etc.). Individual disable directives flag the
      // intentional uses.
      'no-var': 'error',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.integration.test.ts', 'src/test/**'],
    rules: {
      // Test files can use console freely (debug output during development).
      'no-console': 'off',
    },
  },
];
