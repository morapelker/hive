import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { generateTlsCerts, getCertFingerprint } from '../../src/server/tls'

describe('TLS Certificate Generation', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `hive-tls-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('generates cert and key files', () => {
    generateTlsCerts(tempDir)
    expect(existsSync(join(tempDir, 'server.crt'))).toBe(true)
    expect(existsSync(join(tempDir, 'server.key'))).toBe(true)
  })

  it('generates a valid fingerprint (64 hex chars)', () => {
    generateTlsCerts(tempDir)
    const fingerprint = getCertFingerprint(join(tempDir, 'server.crt'))
    expect(fingerprint).toHaveLength(64)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does NOT overwrite existing certs (idempotent)', () => {
    generateTlsCerts(tempDir)
    const certPath = join(tempDir, 'server.crt')
    const firstMtime = statSync(certPath).mtimeMs

    // Small delay to ensure mtime would differ
    const start = Date.now()
    while (Date.now() - start < 50) { /* busy wait */ }

    generateTlsCerts(tempDir)
    const secondMtime = statSync(certPath).mtimeMs
    expect(secondMtime).toBe(firstMtime)
  })

  it('generates cert readable by Node.js TLS', () => {
    generateTlsCerts(tempDir)
    const cert = readFileSync(join(tempDir, 'server.crt'), 'utf-8')
    const key = readFileSync(join(tempDir, 'server.key'), 'utf-8')

    // This throws if cert/key are invalid
    expect(() => {
      tls.createSecureContext({ cert, key })
    }).not.toThrow()
  })
})
