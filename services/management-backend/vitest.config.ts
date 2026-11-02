import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  resolve: { tsconfigPaths: true },
  test: {
    // Bound competing Nest/SWC imports; keep the existing assertion deadlines.
    maxWorkers: 1,
    globals: true,
    root: './',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
  },
});
