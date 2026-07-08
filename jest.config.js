/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  // Coverage counts ALL source files, not just the ones tests import —
  // an untested new module lowers the number instead of hiding.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/test/**',
    '!src/e2e/**',
    '!src/instrumentation.ts', // OTel bootstrap; exercised only at process start
  ],
  // Floors sit a few points under the current suite (~78/77/70/79 as of
  // 2026-07) so CI fails on a real regression, not on noise. Raise them
  // as coverage grows; never lower them to make a PR pass.
  coverageThreshold: {
    global: {
      statements: 74,
      branches: 73,
      functions: 66,
      lines: 75,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          jsx: 'react-jsx',
        },
      },
    ],
  },
};
