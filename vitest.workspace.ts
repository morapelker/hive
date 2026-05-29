import { defineWorkspace } from 'vitest/config'
import { resolve } from 'path'
import type { Plugin } from 'vite'

type VitestResolvedConfig = Parameters<NonNullable<Plugin['configResolved']>>[0] & {
  test: { include: string[] }
}

const mainInclude = [
  'test/session-3/**/*.test.ts',
  'test/session-7/**/*.test.ts',
  'test/phase-9/session-2/**/*.test.ts',
  'test/phase-9/session-5/**/*.test.ts',
  'test/phase-9/session-13/**/*.test.ts',
  'test/phase-21/**/*.test.ts',
  'test/kanban/session-1/**/*.test.ts',
  'test/kanban/session-2/**/*.test.ts',
  'test/kanban/session-3/**/*.test.ts',
  'test/codex-migration/**/*.test.ts',
  'test/utils/**/*.test.ts',
  'src/main/effect/**/*.test.ts',
  'src/main/ipc/**/*.test.ts',
  'src/main/services/**/*.test.ts'
]

const overrideMainInclude: Plugin = {
  name: 'override-main-test-include',
  configResolved(config): void {
    // Vitest/Vite concatenates array fields from `extends`; keep the main
    // project scoped to its node-only include list after inheriting coverage.
    ;(config as VitestResolvedConfig).test.include = mainInclude
  }
}

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'renderer',
      environment: 'jsdom',
      testTimeout: 30000,
      include: [
        'test/**/*.test.{ts,tsx}',
        'src/renderer/src/**/*.test.{ts,tsx}',
        'src/shared/**/*.test.{ts,tsx}'
      ],
      exclude: [
        'test/session-3/**/*.test.ts',
        'test/session-7/**/*.test.ts',
        'test/phase-9/session-2/**/*.test.ts',
        'test/phase-9/session-5/**/*.test.ts',
        'test/phase-9/session-13/**/*.test.ts',
        'test/phase-21/**/*.test.ts',
        'test/kanban/session-1/**/*.test.ts',
        'test/kanban/session-2/**/*.test.ts',
        'test/kanban/session-3/**/*.test.ts',
        'test/codex-migration/**/*.test.ts',
        'test/utils/**/*.test.ts'
      ]
    }
  },
  {
    extends: './vitest.config.ts',
    plugins: [overrideMainInclude],
    test: {
      name: 'main',
      environment: 'node',
      include: mainInclude,
      globals: true
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        electron: resolve(__dirname, 'test/__mocks__/electron.ts')
      }
    }
  }
])
