import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-24 at 93.79 / 83.65 / 95.32 / 95.82, with roughly
      // five points of headroom on functions. Write the missing tests instead
      // of lowering them.
      thresholds: { statements: 91, branches: 80, functions: 90, lines: 93 },
    },
  },
});
