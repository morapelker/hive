import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDesktopBootstrapToken,
  makeDesktopBackendSpawnConfig,
  parseDesktopBackendPortEnv,
  resolveDesktopBackendEntryPath,
  resolveDesktopWebStaticDir,
  selectDesktopBackendPort
} from './backend-config'

describe('desktop backend config', () => {
  it('generates a 48-character bootstrap token', () => {
    expect(createDesktopBootstrapToken()).toMatch(/^[0-9a-f]{48}$/)
  })

  it('parses a valid HIVE_DESKTOP_BACKEND_PORT override', () => {
    expect(parseDesktopBackendPortEnv('51234')).toBe(51234)
    expect(parseDesktopBackendPortEnv('0')).toBe(0)
  })

  it('ignores missing or invalid port overrides', () => {
    expect(parseDesktopBackendPortEnv(undefined)).toBeUndefined()
    expect(parseDesktopBackendPortEnv('')).toBeUndefined()
    expect(parseDesktopBackendPortEnv('not-a-number')).toBeUndefined()
    expect(parseDesktopBackendPortEnv('70000')).toBeUndefined()
  })

  it('selects the next port when the default is occupied', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const selected = await selectDesktopBackendPort('127.0.0.1', address.port, address.port + 1)
    expect(selected).toBe(address.port + 1)

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('builds spawn config with node-mode env and local URLs', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({
      executablePath: '/electron',
      entryPath: '/app/server.js',
      cwd: '/app',
      baseDir,
      host: '127.0.0.1',
      port: 0,
      bootstrapToken: 'a'.repeat(48),
      env: { KEEP_ME: 'yes' }
    })

    expect(config).toMatchObject({
      executablePath: '/electron',
      entryPath: '/app/server.js',
      cwd: '/app',
      baseDir,
      host: '127.0.0.1',
      bootstrapToken: 'a'.repeat(48)
    })
    expect(config.port).toBeGreaterThanOrEqual(0)
    expect(config.httpBaseUrl).toBe(`http://127.0.0.1:${config.port}`)
    expect(config.wsBaseUrl).toBe(`ws://127.0.0.1:${config.port}/ws`)
    expect(config.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(config.env.HIVE_SERVER_MODE).toBe('desktop')
    expect(config.env.HIVE_SERVER_BASE_DIR).toBe(baseDir)
    expect(config.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN).toBe('a'.repeat(48))
    expect(config.env.KEEP_ME).toBe('yes')
  })

  it('uses BIND_IP as the default backend host when set', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({
      baseDir,
      port: 0,
      env: { BIND_IP: '0.0.0.0', HIVE_SERVER_REQUIRE_AUTH: 'true' }
    })

    expect(config.host).toBe('0.0.0.0')
    expect(config.httpBaseUrl).toBe(`http://0.0.0.0:${config.port}`)
    expect(config.wsBaseUrl).toBe(`ws://0.0.0.0:${config.port}/ws`)
    expect(config.env.HIVE_SERVER_HOST).toBe('0.0.0.0')
    expect(config.env.HIVE_SERVER_REQUIRE_AUTH).toBe('true')
  })

  it('forces auth on even when the environment disables it', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({
      baseDir,
      port: 0,
      env: { HIVE_SERVER_REQUIRE_AUTH: 'false' }
    })

    expect(config.env.HIVE_SERVER_REQUIRE_AUTH).toBe('true')
  })

  it('prefers an explicit backend host over BIND_IP', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({
      baseDir,
      host: '127.0.0.1',
      port: 0,
      env: { BIND_IP: '0.0.0.0', HIVE_SERVER_REQUIRE_AUTH: 'true' }
    })

    expect(config.host).toBe('127.0.0.1')
    expect(config.env.HIVE_SERVER_HOST).toBe('127.0.0.1')
  })

  it('serves static web UI while requiring backend auth on loopback', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({
      baseDir,
      port: 0,
      staticDir: '/app/out/renderer-web'
    })

    expect(config.env.HIVE_SERVER_REQUIRE_AUTH).toBe('true')
    expect(config.env.HIVE_SERVER_STATIC_DIR).toBe('/app/out/renderer-web')
  })

  it('derives the web static dir as a sibling of the server bundle by default', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-desktop-backend-'))
    const config = await makeDesktopBackendSpawnConfig({ baseDir, port: 0 })

    expect(config.env.HIVE_SERVER_STATIC_DIR).toMatch(/renderer-web$/)
  })

  it('resolves renderer-web as a sibling of the server bundle, regardless of chunk depth', () => {
    // The server entry is at out/main/server.js; the web build is at out/renderer-web.
    // Deriving from the entry path must not depend on where backend-config itself is
    // chunked (it may be bundled under out/main/chunks).
    expect(resolveDesktopWebStaticDir('/app/out/main/server.js')).toBe('/app/out/renderer-web')
  })

  it('resolves the bundled server entry next to main chunks', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'hive-desktop-entry-'))
    const chunksDir = join(outDir, 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(join(outDir, 'server.js'), '')

    expect(resolveDesktopBackendEntryPath(chunksDir)).toBe(join(outDir, 'server.js'))
  })
})
