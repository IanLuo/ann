import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '**/*.d.ts', 'src/adapters/**'],
  },
});
