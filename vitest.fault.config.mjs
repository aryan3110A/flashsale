import { defineConfig } from 'vitest/config';
// Stops and starts real containers - run only against the local test stack.
export default defineConfig({
  test: { include: ['tests/fault/**/*.test.js'], environment: 'node', testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false, sequence: { concurrent: false } },
});
