import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/integration/**/*.spec.ts', 'test/app.e2e-spec.ts'],
    globalSetup: ['./test/support/pg-harness.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
