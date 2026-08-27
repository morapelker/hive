import { describe, expect, it } from 'vitest'
import {
  AUTO_PIN_MODES,
  isAutoPinMode,
  migrateLegacyAutoPinSetting
} from '@/stores/useSettingsStore'

/**
 * The auto-pin setting changed from the boolean
 * `autoPinBaseWorktreeOnBoardPrompt` to the 3-way `autoPinOnBoardPrompt`
 * mode. Both persistence layers (settings DB row + localStorage 'hive-settings')
 * run this migration on load so existing users keep their behavior.
 */
describe('migrateLegacyAutoPinSetting', () => {
  it('maps legacy true → root-branch (the old "on" pinned the root/base worktree)', () => {
    const migrated = migrateLegacyAutoPinSetting({
      autoPinBaseWorktreeOnBoardPrompt: true,
      boardMode: 'sticky-tab'
    })

    expect(migrated).toEqual({ autoPinOnBoardPrompt: 'root-branch', boardMode: 'sticky-tab' })
    expect('autoPinBaseWorktreeOnBoardPrompt' in migrated).toBe(false)
  })

  it('maps legacy false → off', () => {
    expect(migrateLegacyAutoPinSetting({ autoPinBaseWorktreeOnBoardPrompt: false })).toEqual({
      autoPinOnBoardPrompt: 'off'
    })
  })

  it('treats a non-boolean legacy value as off', () => {
    expect(migrateLegacyAutoPinSetting({ autoPinBaseWorktreeOnBoardPrompt: 'yes' })).toEqual({
      autoPinOnBoardPrompt: 'off'
    })
  })

  it('leaves settings that never had the legacy key alone (default applies via merge)', () => {
    const input = { boardMode: 'toggle' }
    const migrated = migrateLegacyAutoPinSetting(input)

    expect(migrated).toBe(input)
    expect('autoPinOnBoardPrompt' in migrated).toBe(false)
  })

  it('keeps an explicit new-key choice over a lingering legacy key', () => {
    expect(
      migrateLegacyAutoPinSetting({
        autoPinBaseWorktreeOnBoardPrompt: true,
        autoPinOnBoardPrompt: 'current-branch'
      })
    ).toEqual({ autoPinOnBoardPrompt: 'current-branch' })
    expect(
      migrateLegacyAutoPinSetting({
        autoPinBaseWorktreeOnBoardPrompt: true,
        autoPinOnBoardPrompt: 'off'
      })
    ).toEqual({ autoPinOnBoardPrompt: 'off' })
  })

  it('returns already-migrated settings untouched', () => {
    const input = { autoPinOnBoardPrompt: 'root-branch', boardMode: 'toggle' }
    expect(migrateLegacyAutoPinSetting(input)).toBe(input)
  })

  it('drops an unrecognized new-key value so the default applies', () => {
    expect(migrateLegacyAutoPinSetting({ autoPinOnBoardPrompt: 'sideways' })).toEqual({})
    // ...unless a legacy key can still say what the user wanted
    expect(
      migrateLegacyAutoPinSetting({
        autoPinOnBoardPrompt: 'sideways',
        autoPinBaseWorktreeOnBoardPrompt: true
      })
    ).toEqual({ autoPinOnBoardPrompt: 'root-branch' })
  })

  it('is idempotent', () => {
    const once = migrateLegacyAutoPinSetting({ autoPinBaseWorktreeOnBoardPrompt: true })
    expect(migrateLegacyAutoPinSetting(once)).toBe(once)
  })
})

describe('isAutoPinMode', () => {
  it('accepts exactly the three modes', () => {
    expect(AUTO_PIN_MODES).toEqual(['off', 'root-branch', 'current-branch'])
    for (const mode of AUTO_PIN_MODES) expect(isAutoPinMode(mode)).toBe(true)
    expect(isAutoPinMode(true)).toBe(false)
    expect(isAutoPinMode('on')).toBe(false)
    expect(isAutoPinMode(undefined)).toBe(false)
  })
})
