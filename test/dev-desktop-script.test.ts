import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('dev desktop script', () => {
  test('defaults HIVE_SERVER_ENTRY_PATH to the copied dev server bundle', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: { PATH: '/bin' }
    })

    expect(env.HIVE_SERVER_ENTRY_PATH).toBe(resolve('/repo/hive/.dev-server/server.js'))
  })

  test('preserves an explicit HIVE_SERVER_ENTRY_PATH', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: {
        PATH: '/bin',
        HIVE_SERVER_ENTRY_PATH: '/custom/server.js'
      }
    })

    expect(env.HIVE_SERVER_ENTRY_PATH).toBe('/custom/server.js')
  })

  test('does not pass ELECTRON_RUN_AS_NODE into electron-vite dev', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: {
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1'
      }
    })

    expect(env.PATH).toBe('/bin')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  test('dev:desktop uses the desktop dev launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['dev:desktop']).toBe('node scripts/dev-desktop.mjs')
  })
})
