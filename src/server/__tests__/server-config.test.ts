import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST, DEFAULT_PORT, deriveServerPaths, resolveServerConfig } from '../config'

describe('server config', () => {
  it('derives stable server state paths from the base directory', () => {
    const baseDir = '/tmp/hive-test'

    expect(deriveServerPaths(baseDir)).toEqual({
      stateDir: '/tmp/hive-test/userdata',
      dbPath: '/tmp/hive-test/userdata/state.sqlite',
      attachmentsDir: '/tmp/hive-test/userdata/attachments',
      logsDir: '/tmp/hive-test/userdata/logs'
    })
  })

  it('resolves defaults and environment overrides', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-server-config-'))
    const config = await Effect.runPromise(
      resolveServerConfig(
        {},
        {
          HIVE_SERVER_BASE_DIR: baseDir,
          HIVE_SERVER_MODE: 'browser',
          HIVE_SERVER_PORT: '0',
          HIVE_DESKTOP_BOOTSTRAP_TOKEN: 'desktop-token'
        }
      )
    )

    expect(config).toMatchObject({
      mode: 'browser',
      host: DEFAULT_HOST,
      port: 0,
      baseDir,
      desktopBootstrapToken: 'desktop-token',
      logLevel: 'info'
    })
  })

  it('falls back to safe defaults for invalid environment values', async () => {
    const config = await Effect.runPromise(
      resolveServerConfig(
        { baseDir: mkdtempSync(join(tmpdir(), 'hive-server-config-')) },
        {
          HIVE_SERVER_MODE: 'invalid',
          HIVE_SERVER_PORT: '999999',
          HIVE_SERVER_LOG_LEVEL: 'trace'
        }
      )
    )

    expect(config.mode).toBe('desktop')
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.logLevel).toBe('info')
  })

  it('requires auth by default', async () => {
    const config = await Effect.runPromise(
      resolveServerConfig({ baseDir: mkdtempSync(join(tmpdir(), 'hive-server-config-')) }, {})
    )

    expect(config.requireAuth).toBe(true)
  })

  it('disables auth when HIVE_SERVER_REQUIRE_AUTH is false', async () => {
    const config = await Effect.runPromise(
      resolveServerConfig(
        { baseDir: mkdtempSync(join(tmpdir(), 'hive-server-config-')) },
        { HIVE_SERVER_REQUIRE_AUTH: 'false' }
      )
    )

    expect(config.requireAuth).toBe(false)
  })

  it('resolves the static directory from HIVE_SERVER_STATIC_DIR', async () => {
    const config = await Effect.runPromise(
      resolveServerConfig(
        { baseDir: mkdtempSync(join(tmpdir(), 'hive-server-config-')) },
        { HIVE_SERVER_STATIC_DIR: '/tmp/hive-web' }
      )
    )

    expect(config.staticDir).toBe('/tmp/hive-web')
  })
})

