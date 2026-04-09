// @vitest-environment node
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

import { vi } from 'vitest'

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { generateCodexSessionTitle } from '../src/main/services/codex-session-title'

const canRunLiveTest =
  process.env.LIVE_CODEX_TITLE_TEST === '1' &&
  spawnSync('codex', ['--version'], { encoding: 'utf-8' }).status === 0

const describeIf = canRunLiveTest ? describe : describe.skip

function expectSuitableTitle(title: string | null, tokens: string[], originalMessage: string): void {
  expect(title).toBeTruthy()
  expect(title).not.toBe(originalMessage)
  expect(title!.length).toBeLessThanOrEqual(53)

  const normalizedTitle = title!.toLowerCase()
  expect(tokens.some((token) => normalizedTitle.includes(token))).toBe(true)
}

describeIf('generateCodexSessionTitle live', () => {
  it(
    'generates a suitable auth-related title',
    async () => {
      const message = 'Fix auth token refresh bug in src/auth.ts'
      const title = await generateCodexSessionTitle(message)

      expectSuitableTitle(title, ['auth', 'token', 'refresh'], message)
    },
    45_000
  )

  it(
    'generates a suitable dark-mode title',
    async () => {
      const message = 'Add dark mode toggle to settings page'
      const title = await generateCodexSessionTitle(message)

      expectSuitableTitle(title, ['dark', 'mode', 'settings'], message)
    },
    45_000
  )

  it(
    'generates a non-literal title for a minimal greeting',
    async () => {
      const message = 'hello'
      const title = await generateCodexSessionTitle(message)

      expect(title).toBeTruthy()
      expect(title).not.toBe(message)
      expect(title!.length).toBeLessThanOrEqual(53)
    },
    45_000
  )
})
