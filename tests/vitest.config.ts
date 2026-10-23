import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(__dirname, '..')

/**
 * Vitest config for the AIDB Studio test suite.
 *
 * The canonical entry point is the root `vitest.config.ts` (added by the Lead);
 * this file exists so the suite can also be run without touching the repo root:
 *
 *   npx vitest run --config tests/vitest.config.ts
 *
 * Tests never use mocks for the modules under test; database tests talk to the
 * real portable MariaDB instance started by scripts/mariadb.mjs.
 */
export default defineConfig({
  root,
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/._*', '**/.*'],
    environment: 'node',
    // Integration tests share one MariaDB instance and a handful of test
    // databases; running files sequentially keeps them isolated and avoids
    // cross-test interference on the same schema.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
    reporters: ['default']
  }
})
