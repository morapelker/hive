// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../keychain', () => ({
  keychainRead: vi.fn(async () => null),
  keychainWrite: vi.fn(),
  keychainDelete: vi.fn(),
  keychainListAccounts: vi.fn(async () => [])
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { readClaudeAccountIndexUpdatedAt } from '../account-store-claude'
import { keychainRead } from '../keychain'

let storeDir: string
let savedStoreDir: string | undefined

function writeIndex(index: Record<string, unknown>): void {
  writeFileSync(join(storeDir, 'sequence.json'), JSON.stringify(index))
}

beforeEach(() => {
  savedStoreDir = process.env.HIVE_CLAUDE_STORE_DIR
  storeDir = mkdtempSync(join(tmpdir(), 'claude-store-index-'))
  process.env.HIVE_CLAUDE_STORE_DIR = storeDir
})

afterEach(() => {
  if (savedStoreDir === undefined) delete process.env.HIVE_CLAUDE_STORE_DIR
  else process.env.HIVE_CLAUDE_STORE_DIR = savedStoreDir
  rmSync(storeDir, { recursive: true, force: true })
})

describe('readClaudeAccountIndexUpdatedAt', () => {
  it('is the moment the index was last stamped, read without the Keychain', async () => {
    writeIndex({
      activeAccountNumber: 2,
      lastUpdated: '2026-11-01T10:36:56.000Z',
      sequence: [1, 2],
      accounts: {
        '1': { email: 'a@example.com', uuid: 'u-a', added: '2026-01-01' },
        '2': { email: 'b@example.com', uuid: 'u-b', added: '2026-01-01' }
      }
    })

    expect(await readClaudeAccountIndexUpdatedAt()).toBe(Date.UTC(2026, 10, 1, 10, 36, 56))
    expect(keychainRead).not.toHaveBeenCalled()
  })

  it('sees a stamp another process wrote since the last read', async () => {
    writeIndex({ lastUpdated: '2026-11-01T10:00:00.000Z', sequence: [], accounts: {} })
    expect(await readClaudeAccountIndexUpdatedAt()).toBe(Date.UTC(2026, 10, 1, 10, 0, 0))

    writeIndex({ lastUpdated: '2026-11-01T10:36:56.000Z', sequence: [], accounts: {} })
    expect(await readClaudeAccountIndexUpdatedAt()).toBe(Date.UTC(2026, 10, 1, 10, 36, 56))
  })

  it('counts a missing index or an unreadable stamp as changed just now, never as long ago', async () => {
    const before = Date.now()
    expect(await readClaudeAccountIndexUpdatedAt()).toBeGreaterThanOrEqual(before)

    writeIndex({ lastUpdated: 'not a date', sequence: [], accounts: {} })
    expect(await readClaudeAccountIndexUpdatedAt()).toBeGreaterThanOrEqual(before)

    writeIndex({ sequence: [], accounts: {} })
    expect(await readClaudeAccountIndexUpdatedAt()).toBeGreaterThanOrEqual(before)
  })
})
