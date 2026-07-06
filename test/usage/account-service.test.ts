// @vitest-environment node
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  homeDir: '/tmp/hive-account-service-test'
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => mocks.homeDir }
})

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { getClaudeAccountEmail } from '../../src/main/services/account-service'

describe('getClaudeAccountEmail', () => {
  beforeEach(async () => {
    mocks.homeDir = await mkdtemp(join(tmpdir(), 'hive-account-service-'))
  })

  afterEach(async () => {
    await rm(mocks.homeDir, { recursive: true, force: true })
  })

  it('prefers the nested ~/.claude/.claude.json over the top-level file and lowercases the email', async () => {
    // Top-level (legacy) file carries the OLD account…
    await writeFile(
      join(mocks.homeDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'old@example.com' } })
    )
    // …but the nested ccswitch-primary file was written by a switch to a NEW
    // (mixed-case) account. The nested file must win, lowercased.
    await mkdir(join(mocks.homeDir, '.claude'), { recursive: true })
    await writeFile(
      join(mocks.homeDir, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'New.Account@Example.com' } })
    )

    await expect(getClaudeAccountEmail()).resolves.toBe('new.account@example.com')
  })

  it('falls back to the top-level file (lowercased) when no nested file exists', async () => {
    await writeFile(
      join(mocks.homeDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'Top.Level@Example.com' } })
    )

    await expect(getClaudeAccountEmail()).resolves.toBe('top.level@example.com')
  })

  it('returns null when no identity file is present', async () => {
    await expect(getClaudeAccountEmail()).resolves.toBeNull()
  })
})
