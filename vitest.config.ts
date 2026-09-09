import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '**/*.d.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/e2e/**', 'src/**/__tests__/**'],
      reporters: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
