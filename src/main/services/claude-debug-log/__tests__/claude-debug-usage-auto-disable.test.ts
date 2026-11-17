// @vitest-environment node
// The switch-off of the debug log for a CLI version it gives no readings with (Code Mode T19;
// PRD FR-32): what counts, when new launches are blocked, what lifts the block, what is kept
// across a restart, and that the person is told once. The store is the settings table as a
// map; the CLI's version is whatever the test says the binary at a path reports.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeModeUsageUnavailablePayload } from '@shared/types/claude-live-usage'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('../../logger', () => ({
  createLogger: () => logMock
}))

import {
  CLAUDE_DEBUG_USAGE_AUTO_DISABLE_AFTER,
  CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY,
  CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY,
  ClaudeDebugUsageAutoDisable,
  claimClaudeDebugUsageAutoDisableNotice,
  readClaudeDebugUsageAutoDisableState,
  type ClaudeDebugUsageAutoDisableDeps,
  type ClaudeDebugUsageAutoDisableStore
} from '../claude-debug-usage-auto-disable'

const CLI = '/usr/local/bin/claude'
const NOW = 1_800_000_000_000

/** The `settings` table: what survives a restart of the app. */
let rows: Map<string, string>
let store: ClaudeDebugUsageAutoDisableStore
/** What the binary at each path reports right now. */
let cliVersions: Map<string, string | null>
let appVersion: string
let cliVersionAsked: number
let notices: ClaudeCodeModeUsageUnavailablePayload[]

/** The app as it runs: start it again and it has only what the store kept. */
const startApp = (
  overrides: Partial<ClaudeDebugUsageAutoDisableDeps> = {}
): ClaudeDebugUsageAutoDisable =>
  new ClaudeDebugUsageAutoDisable({
    store: () => store,
    appVersion: () => appVersion,
    cliVersion: async (path) => {
      cliVersionAsked += 1
      return cliVersions.get(path) ?? null
    },
    onBlocked: (notice) => notices.push(notice),
    now: () => NOW,
    ...overrides
  })

/** Let what a launch reported be counted: its version is waited for first. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** A `debug-log` launch whose log never gives a reading. */
const failedLaunch = async (guard: ClaudeDebugUsageAutoDisable, cliPath = CLI): Promise<void> => {
  guard.launch(cliPath).degraded()
  await settle()
}

/** A `debug-log` launch whose log gives a reading. */
const healthyLaunch = async (guard: ClaudeDebugUsageAutoDisable, cliPath = CLI): Promise<void> => {
  guard.launch(cliPath).healthy()
  await settle()
}

beforeEach(() => {
  for (const fn of Object.values(logMock)) fn.mockClear()
  rows = new Map()
  store = {
    getSetting: (key) => rows.get(key) ?? null,
    setSetting: (key, value) => void rows.set(key, value),
    deleteSetting: (key) => void rows.delete(key)
  }
  cliVersions = new Map([[CLI, '2.1.326']])
  appVersion = '1.4.0'
  cliVersionAsked = 0
  notices = []
})

describe('ClaudeDebugUsageAutoDisable', () => {
  it('switches the debug log off after three failed launches in a row on one CLI version', async () => {
    const guard = startApp()
    expect(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_AFTER).toBe(3)

    await failedLaunch(guard)
    expect(await guard.blocks(CLI)).toBe(false)
    await failedLaunch(guard)
    expect(await guard.blocks(CLI)).toBe(false)
    expect(guard.state()).toEqual({
      cliVersion: '2.1.326',
      appVersion: '1.4.0',
      failures: 2,
      blockedAt: null
    })
    expect(notices).toEqual([])

    await failedLaunch(guard)

    // The fourth launch does without.
    expect(await guard.blocks(CLI)).toBe(true)
    expect(guard.state()).toEqual({
      cliVersion: '2.1.326',
      appVersion: '1.4.0',
      failures: 3,
      blockedAt: NOW
    })
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Live usage in Code Mode is switched off'),
      { cliVersion: '2.1.326', appVersion: '1.4.0', failures: 3 }
    )
  })

  it('starts the count again with a healthy launch between failures', async () => {
    const guard = startApp()

    await failedLaunch(guard)
    await failedLaunch(guard)
    await healthyLaunch(guard)
    expect(guard.state()).toBeNull()
    await failedLaunch(guard)
    await failedLaunch(guard)

    expect(await guard.blocks(CLI)).toBe(false)
    expect(guard.state()).toMatchObject({ failures: 2, blockedAt: null })

    await failedLaunch(guard)
    expect(await guard.blocks(CLI)).toBe(true)
  })

  it('counts a launch once, however often it says it is degraded', async () => {
    const guard = startApp()
    const launch = guard.launch(CLI)

    launch.degraded()
    launch.degraded()
    launch.degraded()
    await settle()

    expect(guard.state()).toMatchObject({ failures: 1, blockedAt: null })
  })

  it('takes a launch that recovers as healthy: the log can work with this version', async () => {
    const guard = startApp()
    await failedLaunch(guard)
    const launch = guard.launch(CLI)

    launch.degraded()
    await settle()
    expect(guard.state()).toMatchObject({ failures: 2 })
    launch.healthy()
    await settle()

    expect(guard.state()).toBeNull()
  })

  it('does not count a launch that degrades after it gave a reading', async () => {
    const guard = startApp()
    await failedLaunch(guard)
    await failedLaunch(guard)
    const launch = guard.launch(CLI)

    launch.healthy()
    // Its log passed the hard cap later: that says nothing about the version.
    launch.degraded()
    await settle()

    expect(guard.state()).toBeNull()
    expect(await guard.blocks(CLI)).toBe(false)
  })

  it('counts nothing for a launch that reports nothing', async () => {
    const guard = startApp()
    await failedLaunch(guard)
    await failedLaunch(guard)

    // Opened and closed without a turn, three times over.
    guard.launch(CLI)
    guard.launch(CLI)
    guard.launch(CLI)
    await settle()

    expect(guard.state()).toMatchObject({ failures: 2, blockedAt: null })
  })

  it('counts each CLI version on its own', async () => {
    const guard = startApp()
    await failedLaunch(guard)
    await failedLaunch(guard)

    // The CLI updated itself; the first launch of the new version fails too.
    cliVersions.set(CLI, '2.1.327')
    await failedLaunch(guard)

    expect(guard.state()).toEqual({
      cliVersion: '2.1.327',
      appVersion: '1.4.0',
      failures: 1,
      blockedAt: null
    })
    expect(await guard.blocks(CLI)).toBe(false)
  })

  it('counts a launch for the version it started with, not the one on disk when it fails', async () => {
    const guard = startApp()
    const launch = guard.launch(CLI)
    await settle()

    cliVersions.set(CLI, '2.1.327')
    launch.degraded()
    await settle()

    expect(guard.state()).toMatchObject({ cliVersion: '2.1.326', failures: 1 })
  })

  it('leaves the count of one version alone when a launch of another is healthy', async () => {
    const other = '/opt/claude/bin/claude'
    cliVersions.set(other, '2.0.0')
    const guard = startApp()
    await failedLaunch(guard)
    await failedLaunch(guard)

    await healthyLaunch(guard, other)

    expect(guard.state()).toMatchObject({ cliVersion: '2.1.326', failures: 2 })
  })

  it('keeps the block across a restart of the app on the same versions', async () => {
    const before = startApp()
    await failedLaunch(before)
    await failedLaunch(before)
    await failedLaunch(before)

    const after = startApp()

    expect(await after.blocks(CLI)).toBe(true)
    expect(await after.blocks(CLI)).toBe(true)
  })

  it('keeps the count across a restart too', async () => {
    const before = startApp()
    await failedLaunch(before)
    await failedLaunch(before)

    const after = startApp()
    expect(await after.blocks(CLI)).toBe(false)
    await failedLaunch(after)

    expect(await after.blocks(CLI)).toBe(true)
  })

  it('lifts the block when the CLI is another version', async () => {
    const guard = startApp()
    await failedLaunch(guard)
    await failedLaunch(guard)
    await failedLaunch(guard)
    expect(await guard.blocks(CLI)).toBe(true)

    cliVersions.set(CLI, '2.1.327')

    expect(await guard.blocks(CLI)).toBe(false)
    expect(rows.size).toBe(0)
    expect(logMock.info).toHaveBeenCalledWith(expect.stringContaining('tried again'), {
      blockedCliVersion: '2.1.326',
      blockedAppVersion: '1.4.0',
      cliVersion: '2.1.327'
    })
    // It is gone, not waiting: going back to the old version starts from nothing.
    cliVersions.set(CLI, '2.1.326')
    expect(await guard.blocks(CLI)).toBe(false)
  })

  it('lifts the block when the app is another version', async () => {
    const before = startApp()
    await failedLaunch(before)
    await failedLaunch(before)
    await failedLaunch(before)

    appVersion = '1.4.1'
    const after = startApp()

    expect(await after.blocks(CLI)).toBe(false)
    expect(rows.size).toBe(0)
    // The count starts from nothing on the new app version.
    await failedLaunch(after)
    expect(after.state()).toMatchObject({ appVersion: '1.4.1', failures: 1, blockedAt: null })
  })

  it('does not carry a count over to another app version', async () => {
    const before = startApp()
    await failedLaunch(before)
    await failedLaunch(before)

    appVersion = '1.4.1'
    const after = startApp()
    await failedLaunch(after)

    expect(after.state()).toEqual({
      cliVersion: '2.1.326',
      appVersion: '1.4.1',
      failures: 1,
      blockedAt: null
    })
  })

  it('does not ask for the CLI version of a launch decision while nothing is switched off', async () => {
    const guard = startApp()

    expect(await guard.blocks(CLI)).toBe(false)
    await failedLaunch(guard)
    cliVersionAsked = 0
    expect(await guard.blocks(CLI)).toBe(false)

    expect(cliVersionAsked).toBe(0)
  })

  it('ignores what launches from before the block report after it', async () => {
    const guard = startApp()
    const running = [guard.launch(CLI), guard.launch(CLI)]
    await failedLaunch(guard)
    await failedLaunch(guard)
    await failedLaunch(guard)
    const blocked = guard.state()

    running[0].degraded()
    running[1].healthy()
    await settle()

    expect(guard.state()).toEqual(blocked)
    expect(await guard.blocks(CLI)).toBe(true)
  })

  describe('when something is not known', () => {
    it('neither counts nor blocks a launch whose CLI version cannot be told', async () => {
      const guard = startApp()
      cliVersions.set(CLI, null)

      await failedLaunch(guard)
      await failedLaunch(guard)
      await failedLaunch(guard)
      guard.launch(null).degraded()
      await settle()

      expect(guard.state()).toBeNull()
      expect(await guard.blocks(CLI)).toBe(false)
      expect(await guard.blocks(null)).toBe(false)
    })

    it('gives a launch its debug log when a block is stored and its own version cannot be told', async () => {
      const guard = startApp()
      await failedLaunch(guard)
      await failedLaunch(guard)
      await failedLaunch(guard)

      cliVersions.set(CLI, null)
      expect(await guard.blocks(CLI)).toBe(false)

      // Nothing was lifted: the block is there again once the version is.
      cliVersions.set(CLI, '2.1.326')
      expect(await guard.blocks(CLI)).toBe(true)
    })

    it('neither counts nor blocks when the version of the binary cannot be asked', async () => {
      const guard = startApp({
        cliVersion: async () => {
          throw new Error('the binary is gone')
        }
      })

      await failedLaunch(guard)

      expect(guard.state()).toBeNull()
      expect(await guard.blocks(CLI)).toBe(false)
    })

    it('neither counts nor blocks when the app version is not known', async () => {
      const guard = startApp()
      await failedLaunch(guard)
      await failedLaunch(guard)
      await failedLaunch(guard)

      appVersion = ''
      const unknown = startApp()
      await failedLaunch(unknown)

      expect(await unknown.blocks(CLI)).toBe(false)
      expect(unknown.state()).toMatchObject({ appVersion: '1.4.0', failures: 3 })
    })

    it('blocks nothing and never throws when the database cannot be used', async () => {
      const guard = startApp({
        store: () => {
          throw new Error('database is closed')
        }
      })

      await failedLaunch(guard)
      await healthyLaunch(guard)

      expect(await guard.blocks(CLI)).toBe(false)
      expect(guard.state()).toBeNull()
    })

    it.each([
      ['not JSON', '{'],
      ['not an object', '"blocked"'],
      ['no versions', JSON.stringify({ failures: 3, blockedAt: NOW })],
      [
        'a count that is not one',
        JSON.stringify({
          cliVersion: '2.1.326',
          appVersion: '1.4.0',
          failures: 'many',
          blockedAt: NOW
        })
      ],
      [
        'a time that is not one',
        JSON.stringify({
          cliVersion: '2.1.326',
          appVersion: '1.4.0',
          failures: 3,
          blockedAt: 'yes'
        })
      ]
    ])('takes a stored record that is %s as no record', async (_name, raw) => {
      rows.set(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY, raw)
      const guard = startApp()

      expect(readClaudeDebugUsageAutoDisableState(store)).toBeNull()
      expect(await guard.blocks(CLI)).toBe(false)
      await failedLaunch(guard)
      expect(guard.state()).toMatchObject({ failures: 1, blockedAt: null })
    })
  })

  describe('telling the person', () => {
    const block = async (guard: ClaudeDebugUsageAutoDisable): Promise<void> => {
      await failedLaunch(guard)
      await failedLaunch(guard)
      await failedLaunch(guard)
    }

    it('gives the cue when the third failure comes, with the CLI version and nothing else', async () => {
      const guard = startApp()
      await failedLaunch(guard)
      await failedLaunch(guard)
      expect(notices).toEqual([])

      await failedLaunch(guard)

      expect(notices).toEqual([{ provider: 'anthropic', cliVersion: '2.1.326' }])
    })

    it('gives the notice out once, to whoever claims it first', async () => {
      await block(startApp())

      expect(claimClaudeDebugUsageAutoDisableNotice(store, NOW + 1)).toEqual({
        provider: 'anthropic',
        cliVersion: '2.1.326'
      })
      // A second window, a moment later.
      expect(claimClaudeDebugUsageAutoDisableNotice(store, NOW + 2)).toBeNull()
      expect(claimClaudeDebugUsageAutoDisableNotice(store, NOW + 3)).toBeNull()
    })

    it('has no notice to claim while the debug log is not switched off', async () => {
      const guard = startApp()
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()

      await failedLaunch(guard)
      await failedLaunch(guard)

      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()
      expect(rows.has(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY)).toBe(false)
    })

    it('gives the cue again with each blocked launch until the notice is claimed, and never after', async () => {
      const guard = startApp()
      // No window was there when the third failure came.
      await block(guard)
      expect(notices).toHaveLength(1)

      expect(await guard.blocks(CLI)).toBe(true)
      expect(notices).toHaveLength(2)

      expect(claimClaudeDebugUsageAutoDisableNotice(store)).not.toBeNull()

      expect(await guard.blocks(CLI)).toBe(true)
      expect(await guard.blocks(CLI)).toBe(true)
      expect(notices).toHaveLength(2)
    })

    it('does not tell again after a restart', async () => {
      await block(startApp())
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).not.toBeNull()
      notices = []

      const after = startApp()
      expect(await after.blocks(CLI)).toBe(true)

      expect(notices).toEqual([])
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()
    })

    it('tells again when the next version is switched off too', async () => {
      const guard = startApp()
      await block(guard)
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toMatchObject({ cliVersion: '2.1.326' })

      cliVersions.set(CLI, '2.1.327')
      expect(await guard.blocks(CLI)).toBe(false)
      await block(guard)

      expect(notices).toEqual([
        { provider: 'anthropic', cliVersion: '2.1.326' },
        { provider: 'anthropic', cliVersion: '2.1.327' }
      ])
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toEqual({
        provider: 'anthropic',
        cliVersion: '2.1.327'
      })
      expect(claimClaudeDebugUsageAutoDisableNotice(store)).toBeNull()
    })

    it('still blocks when the cue cannot be given', async () => {
      const guard = startApp({
        onBlocked: () => {
          throw new Error('nobody listens')
        }
      })

      await block(guard)

      expect(await guard.blocks(CLI)).toBe(true)
    })

    it('stores versions, a count and times, and nothing else', async () => {
      await block(startApp())
      claimClaudeDebugUsageAutoDisableNotice(store, NOW + 1)

      expect(JSON.parse(rows.get(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_STATE_KEY)!)).toEqual({
        cliVersion: '2.1.326',
        appVersion: '1.4.0',
        failures: 3,
        blockedAt: NOW
      })
      expect(JSON.parse(rows.get(CLAUDE_DEBUG_USAGE_AUTO_DISABLE_NOTICE_KEY)!)).toEqual({
        cliVersion: '2.1.326',
        appVersion: '1.4.0',
        blockedAt: NOW,
        claimedAt: NOW + 1
      })
    })
  })
})
