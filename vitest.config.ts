import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '**/*.d.ts', 'src/adapters/**', 'src/kernel/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/e2e/**', 'src/**/__tests__/**', 'src/adapters/**', 'src/kernel/**'],
      reporters: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
