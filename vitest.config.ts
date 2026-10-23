import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Single test entry point. Integration tests boot the portable MariaDB instance
 * from `scripts/mariadb.mjs` (never a production database).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // macOS external volumes emit AppleDouble `._*.ts` sidecars; never treat them as tests.
    exclude: ['**/node_modules/**', '**/._*', '**/.*'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 240_000,
    reporters: ['default'],
    // A single worker keeps the portable MariaDB instance deterministic.
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false
  }
})
