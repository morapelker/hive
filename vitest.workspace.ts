import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'renderer',
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      exclude: ['test/session-3/**/*.test.ts', 'test/phase-9/session-2/**/*.test.ts']
    }
  },
  {
    test: {
      name: 'main',
      environment: 'node',
      include: ['test/session-3/**/*.test.ts', 'test/phase-9/session-2/**/*.test.ts'],
      globals: true
    }
  }
])
