import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'workspace-specialists-isolated-e2e',
    root: import.meta.dirname,
    environment: 'node',
    include: ['workspace-specialists.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})