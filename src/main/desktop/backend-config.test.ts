import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDesktopBootstrapToken,
  makeDesktopBackendSpawnConfig,
  resolveDesktopBackendEntryPath,
  selectDesktopBackendPort
} from './backend-config'

describe('desktop backend config', () => {
  it('generates a 48-character bootstrap token', () => {
    expect(createDesktopBootstrapToken()).toMatch(/^[0-9a-f]{48}$/)
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

  it('resolves the bundled server entry next to main chunks', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'hive-desktop-entry-'))
    const chunksDir = join(outDir, 'chunks')
    mkdirSync(chunksDir, { recursive: true })
    writeFileSync(join(outDir, 'server.js'), '')

    expect(resolveDesktopBackendEntryPath(chunksDir)).toBe(join(outDir, 'server.js'))
  })
})
