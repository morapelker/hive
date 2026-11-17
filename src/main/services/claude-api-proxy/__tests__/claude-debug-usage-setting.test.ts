// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSetting: vi.fn() }))
vi.mock('../../../db', () => ({ getDatabase: () => ({ getSetting: mocks.getSetting }) }))

import {
  CLAUDE_DEBUG_USAGE_DISABLE_ENV,
  CLAUDE_DEBUG_USAGE_SETTING_KEY,
  isClaudeDebugUsageEnabled,
  isClaudeDebugUsageKillSwitchSet,
  parseClaudeDebugUsageSetting,
  readClaudeDebugUsageSetting
} from '../claude-debug-usage-setting'

const blob = (settings: Record<string, unknown>): string => JSON.stringify(settings)

describe('live usage in Code Mode sessions: is it enabled right now', () => {
  let previousKillSwitch: string | undefined

  beforeEach(() => {
    mocks.getSetting.mockReset()
    mocks.getSetting.mockReturnValue(null)
    previousKillSwitch = process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV]
    delete process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV]
  })

  afterEach(() => {
    if (previousKillSwitch === undefined) delete process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV]
    else process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV] = previousKillSwitch
  })

  it('names the variable and the setting the ticket names', () => {
    expect(CLAUDE_DEBUG_USAGE_DISABLE_ENV).toBe('HIVE_DISABLE_CLAUDE_DEBUG_USAGE')
    expect(CLAUDE_DEBUG_USAGE_SETTING_KEY).toBe('claudeCodeModeLiveUsage')
  })

  it('is enabled on a fresh install with no stored settings', () => {
    expect(isClaudeDebugUsageEnabled()).toBe(true)
    expect(mocks.getSetting).toHaveBeenCalledWith('app_settings')
  })

  it('is enabled for a blob saved before the setting existed, and with the switch on', () => {
    mocks.getSetting.mockReturnValue(blob({ theme: 'dark' }))
    expect(isClaudeDebugUsageEnabled()).toBe(true)

    mocks.getSetting.mockReturnValue(blob({ claudeCodeModeLiveUsage: true }))
    expect(isClaudeDebugUsageEnabled()).toBe(true)
  })

  it('is disabled after the switch is turned off, and enabled again once it is back on', () => {
    mocks.getSetting.mockReturnValue(blob({ theme: 'dark', claudeCodeModeLiveUsage: false }))
    expect(isClaudeDebugUsageEnabled()).toBe(false)

    // Not cached: the next question sees the switch as it is stored now.
    mocks.getSetting.mockReturnValue(blob({ theme: 'dark', claudeCodeModeLiveUsage: true }))
    expect(isClaudeDebugUsageEnabled()).toBe(true)
  })

  it('is disabled whenever the kill switch is set, whatever the switch says', () => {
    for (const stored of [null, blob({}), blob({ claudeCodeModeLiveUsage: true })]) {
      mocks.getSetting.mockReturnValue(stored)
      expect(isClaudeDebugUsageEnabled({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: '1' })).toBe(false)
    }
    mocks.getSetting.mockReturnValue(blob({ claudeCodeModeLiveUsage: false }))
    expect(isClaudeDebugUsageEnabled({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: '1' })).toBe(false)
  })

  it("reads the kill switch from the app's own environment by default", () => {
    mocks.getSetting.mockReturnValue(blob({ claudeCodeModeLiveUsage: true }))
    process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV] = '1'
    expect(isClaudeDebugUsageKillSwitchSet()).toBe(true)
    expect(isClaudeDebugUsageEnabled()).toBe(false)

    delete process.env[CLAUDE_DEBUG_USAGE_DISABLE_ENV]
    expect(isClaudeDebugUsageKillSwitchSet()).toBe(false)
    expect(isClaudeDebugUsageEnabled()).toBe(true)
  })

  it('treats the kill switch like the proxy one: unset, empty, 0, false and no leave the feature on', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ', 'on']) {
      expect(isClaudeDebugUsageKillSwitchSet({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: value })).toBe(true)
    }
    for (const value of ['', '   ', '0', 'false', 'False', 'no']) {
      expect(isClaudeDebugUsageKillSwitchSet({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: value })).toBe(
        false
      )
    }
    expect(isClaudeDebugUsageKillSwitchSet({})).toBe(false)
    expect(isClaudeDebugUsageEnabled({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: '0' })).toBe(true)
  })

  it('only a stored false turns the switch off', () => {
    expect(parseClaudeDebugUsageSetting(null)).toBe(true)
    expect(parseClaudeDebugUsageSetting(undefined)).toBe(true)
    expect(parseClaudeDebugUsageSetting('')).toBe(true)
    expect(parseClaudeDebugUsageSetting('{not json')).toBe(true)
    expect(parseClaudeDebugUsageSetting('null')).toBe(true)
    expect(parseClaudeDebugUsageSetting(blob({ claudeCodeModeLiveUsage: 'off' }))).toBe(true)
    expect(parseClaudeDebugUsageSetting(blob({ claudeCodeModeLiveUsage: false }))).toBe(false)
  })

  it('reports the default (enabled) when the database cannot be read', () => {
    mocks.getSetting.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(readClaudeDebugUsageSetting()).toBe(true)
    expect(isClaudeDebugUsageEnabled()).toBe(true)
    expect(isClaudeDebugUsageEnabled({ [CLAUDE_DEBUG_USAGE_DISABLE_ENV]: '1' })).toBe(false)
  })
})
