import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadHeadlessConfig, type HeadlessConfig } from '../../src/server/config'

describe('loadHeadlessConfig', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `hive-config-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns defaults when config file does not exist', () => {
    const config = loadHeadlessConfig(join(tempDir, 'nonexistent.json'))
    expect(config.port).toBe(8443)
    expect(config.bindAddress).toBe('0.0.0.0')
    expect(config.security.bruteForceMaxAttempts).toBe(5)
    expect(config.security.bruteForceWindowSec).toBe(60)
    expect(config.security.bruteForceBlockSec).toBe(300)
  })

  it('merges partial config with defaults', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, JSON.stringify({ port: 9443 }))
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(9443)
    expect(config.bindAddress).toBe('0.0.0.0')
    expect(config.security.bruteForceMaxAttempts).toBe(5)
  })

  it('returns defaults for invalid JSON', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, 'not valid json {{{')
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(8443)
  })

  it('merges nested security settings', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(
      configPath,
      JSON.stringify({ security: { bruteForceMaxAttempts: 10 } })
    )
    const config = loadHeadlessConfig(configPath)
    expect(config.security.bruteForceMaxAttempts).toBe(10)
    expect(config.security.bruteForceBlockSec).toBe(300)
  })

  it('merges nested TLS paths', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(
      configPath,
      JSON.stringify({ tls: { certPath: '/custom/cert.pem' } })
    )
    const config = loadHeadlessConfig(configPath)
    expect(config.tls.certPath).toBe('/custom/cert.pem')
    expect(config.tls.keyPath).toContain('server.key')
  })

  it('returns defaults for empty JSON object', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, '{}')
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(8443)
    expect(config.bindAddress).toBe('0.0.0.0')
  })
})
