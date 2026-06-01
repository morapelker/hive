import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { createConnectionDir, deleteConnectionDir, getConnectionsBaseDir } from './connection-service'

const tempHomes: string[] = []

describe('connection service', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const tempHome of tempHomes.splice(0)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('creates and deletes connection directories under the Node home directory', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'hive-connection-home-'))
    tempHomes.push(tempHome)
    vi.stubEnv('HOME', tempHome)

    expect(getConnectionsBaseDir()).toBe(join(tempHome, '.hive', 'connections'))

    const connectionDir = createConnectionDir('connection-1')

    expect(connectionDir).toBe(join(tempHome, '.hive', 'connections', 'connection-1'))
    expect(existsSync(connectionDir)).toBe(true)

    deleteConnectionDir(connectionDir)

    expect(existsSync(connectionDir)).toBe(false)
  })
})
