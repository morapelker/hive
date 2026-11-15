// Cmd+G moved from "Filter Projects" (removed) to "Go to Project" (new). What that means for
// the shortcut registry and for keys users saved before the move.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { settingGet, settingSet } = vi.hoisted(() => ({
  settingGet: vi.fn(),
  settingSet: vi.fn()
}))
vi.mock('@/api/db-api', () => ({
  dbApi: { setting: { get: settingGet, set: settingSet } }
}))

import {
  DEFAULT_SHORTCUTS,
  REMOVED_SHORTCUT_IDS,
  bindingsOverlap,
  getShortcutDefinition,
  getShortcutsByCategory,
  resolveEffectiveBinding,
  withoutRemovedShortcuts,
  type KeyBinding
} from '@/lib/keyboard-shortcuts'
import { useShortcutStore } from '@/stores/useShortcutStore'

const CMD_G: KeyBinding = { key: 'g', modifiers: ['meta'] }
const CMD_SHIFT_F: KeyBinding = { key: 'f', modifiers: ['meta', 'shift'] }
const STORAGE_KEY = 'hive-shortcuts'

const store = () => useShortcutStore.getState()

beforeEach(() => {
  settingGet.mockReset().mockResolvedValue(null)
  settingSet.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  useShortcutStore.setState({ customBindings: {} })
  settingSet.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the default binding', () => {
  it('Go to Project is a Navigation shortcut on Cmd+G', () => {
    const definition = getShortcutDefinition('nav:go-to-project')
    expect(definition).toBeDefined()
    expect(definition!.label).toBe('Go to Project')
    expect(definition!.category).toBe('navigation')
    expect(definition!.defaultBinding).toEqual(CMD_G)
    expect(getShortcutsByCategory('navigation').map((s) => s.id)).toContain('nav:go-to-project')

    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_G)
    expect(store().getDisplayString('nav:go-to-project')).toBe('⌘G')
  })

  it('is the only default on Cmd+G', () => {
    const onCmdG = DEFAULT_SHORTCUTS.filter((s) => bindingsOverlap(s.defaultBinding, CMD_G))
    expect(onCmdG.map((s) => s.id)).toEqual(['nav:go-to-project'])
  })

  it('can be rebound and reset like the others', () => {
    expect(store().setCustomBinding('nav:go-to-project', CMD_SHIFT_F)).toEqual({ success: true })
    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_SHIFT_F)
    expect(store().getDisplayString('nav:go-to-project')).toBe('⌘⇧F')

    // Cmd+G is free now: another action can take it.
    expect(store().setCustomBinding('nav:session-history', CMD_G)).toEqual({ success: true })

    store().removeCustomBinding('nav:session-history')
    store().removeCustomBinding('nav:go-to-project')
    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_G)
  })

  it('refuses Cmd+G for another action while Go to Project has it', () => {
    expect(store().setCustomBinding('nav:session-history', CMD_G)).toEqual({
      success: false,
      conflicts: ['nav:go-to-project']
    })
    expect(store().customBindings).toEqual({})
  })
})

describe('the removed action', () => {
  it('"Filter Projects" is not a shortcut any more', () => {
    expect(getShortcutDefinition('nav:filter-projects')).toBeUndefined()
    expect(DEFAULT_SHORTCUTS.some((s) => s.id === 'nav:filter-projects')).toBe(false)
    expect(DEFAULT_SHORTCUTS.some((s) => s.label === 'Filter Projects')).toBe(false)
    expect(REMOVED_SHORTCUT_IDS.has('nav:filter-projects')).toBe(true)

    expect(store().getEffectiveBinding('nav:filter-projects')).toBeNull()
    expect(store().getDisplayString('nav:filter-projects')).toBe('')
    expect(store().getAllEffectiveBindings().has('nav:filter-projects')).toBe(false)
  })

  it('no removed id is still defined', () => {
    for (const id of REMOVED_SHORTCUT_IDS) {
      expect(getShortcutDefinition(id)).toBeUndefined()
    }
  })
})

describe('a stored custom key for the removed action', () => {
  it('withoutRemovedShortcuts drops it and keeps the rest', () => {
    const kept = { 'session:new': { key: 'j', modifiers: ['meta'] } } as Record<string, KeyBinding>
    expect(withoutRemovedShortcuts({ ...kept, 'nav:filter-projects': CMD_SHIFT_F })).toEqual(kept)
    // Nothing to drop: the same object comes back.
    expect(withoutRemovedShortcuts(kept)).toBe(kept)
  })

  it('is dropped when the shortcuts load from the database, which is cleaned too', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    settingGet.mockResolvedValue(
      JSON.stringify({
        'nav:filter-projects': CMD_SHIFT_F,
        'session:new': { key: 'j', modifiers: ['meta'] }
      })
    )

    await store().loadFromDatabase()

    expect(store().customBindings).toEqual({ 'session:new': { key: 'j', modifiers: ['meta'] } })
    expect(settingSet).toHaveBeenCalledTimes(1)
    expect(settingSet).toHaveBeenCalledWith(
      'keyboard_shortcuts',
      JSON.stringify({ 'session:new': { key: 'j', modifiers: ['meta'] } })
    )
    expect(errors).not.toHaveBeenCalled()

    // Its old key does nothing, and Go to Project keeps Cmd+G.
    expect(store().getEffectiveBinding('nav:filter-projects')).toBeNull()
    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_G)
    // The key it held is free for another action.
    expect(store().getConflicts('nav:session-history', CMD_SHIFT_F)).toEqual([])
  })

  it('does not rewrite the database when there is nothing to drop', async () => {
    settingGet.mockResolvedValue(
      JSON.stringify({ 'session:new': { key: 'j', modifiers: ['meta'] } })
    )
    await store().loadFromDatabase()
    expect(store().customBindings).toEqual({ 'session:new': { key: 'j', modifiers: ['meta'] } })
    expect(settingSet).not.toHaveBeenCalled()
  })

  it('is dropped from the copy in localStorage when it is read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // What the previous version of the app left behind (store version 0).
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          customBindings: {
            'nav:filter-projects': CMD_SHIFT_F,
            'git:push': { key: 'u', modifiers: ['meta', 'shift'] }
          }
        },
        version: 0
      })
    )

    await useShortcutStore.persist.rehydrate()

    expect(store().customBindings).toEqual({
      'git:push': { key: 'u', modifiers: ['meta', 'shift'] }
    })
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.version).toBe(1)
    expect(stored.state.customBindings).toEqual({
      'git:push': { key: 'u', modifiers: ['meta', 'shift'] }
    })
    expect(errors).not.toHaveBeenCalled()
  })

  it('takes no key from a current action, even one saved on Cmd+G itself', () => {
    // Should it still be in memory, it shadows nothing: Go to Project keeps its default.
    const stale = { 'nav:filter-projects': CMD_G }
    expect(resolveEffectiveBinding('nav:go-to-project', stale)).toEqual(CMD_G)
    expect(resolveEffectiveBinding('nav:filter-projects', stale)).toBeNull()

    useShortcutStore.setState({ customBindings: stale })
    expect(store().getAllEffectiveBindings().has('nav:filter-projects')).toBe(false)
    expect(store().getConflicts('nav:session-history', CMD_G)).toEqual(['nav:go-to-project'])
  })
})

describe('a stored custom Cmd+G on another action', () => {
  // Possible before this change for a user who first moved "Filter Projects" off Cmd+G.
  const stored = {
    'nav:filter-projects': CMD_SHIFT_F,
    'session:new': CMD_G
  }

  it('wins: that action keeps Cmd+G and Go to Project has no key', async () => {
    settingGet.mockResolvedValue(JSON.stringify(stored))
    await store().loadFromDatabase()

    expect(store().customBindings).toEqual({ 'session:new': CMD_G })
    expect(store().getEffectiveBinding('session:new')).toEqual(CMD_G)
    expect(store().getEffectiveBinding('nav:go-to-project')).toBeNull()
    expect(store().getDisplayString('nav:go-to-project')).toBe('')

    const all = store().getAllEffectiveBindings()
    expect(all.get('session:new')).toEqual(CMD_G)
    expect(all.has('nav:go-to-project')).toBe(false)
  })

  it('Go to Project is still a listed shortcut and takes a key of its own', () => {
    useShortcutStore.setState({ customBindings: { 'session:new': CMD_G } })
    expect(getShortcutsByCategory('navigation').map((s) => s.id)).toContain('nav:go-to-project')

    // Cmd+G belongs to New Session: asking for it names that action only.
    expect(store().setCustomBinding('nav:go-to-project', CMD_G)).toEqual({
      success: false,
      conflicts: ['session:new']
    })
    expect(store().setCustomBinding('nav:go-to-project', CMD_SHIFT_F)).toEqual({ success: true })
    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_SHIFT_F)
    expect(store().getEffectiveBinding('session:new')).toEqual(CMD_G)
  })

  it('gets Cmd+G back when the other action lets go of it', () => {
    useShortcutStore.setState({ customBindings: { 'session:new': CMD_G } })
    store().removeCustomBinding('session:new')
    expect(store().getEffectiveBinding('nav:go-to-project')).toEqual(CMD_G)
    expect(store().getEffectiveBinding('session:new')).toEqual({ key: 't', modifiers: ['meta'] })
  })

  it('counts Ctrl+G as the same key press (Ctrl is the command key off macOS)', () => {
    const ctrlG: KeyBinding = { key: 'g', modifiers: ['ctrl'] }
    expect(bindingsOverlap(ctrlG, CMD_G)).toBe(true)
    expect(bindingsOverlap({ key: 'G', modifiers: ['meta'] }, CMD_G)).toBe(true)
    expect(bindingsOverlap({ key: 'g', modifiers: ['meta', 'shift'] }, CMD_G)).toBe(false)
    expect(bindingsOverlap({ key: 'h', modifiers: ['meta'] }, CMD_G)).toBe(false)

    expect(resolveEffectiveBinding('nav:go-to-project', { 'session:new': ctrlG })).toBeNull()
  })

  it('leaves every other default alone', () => {
    const custom = { 'session:new': CMD_G }
    for (const shortcut of DEFAULT_SHORTCUTS) {
      if (shortcut.id === 'session:new' || shortcut.id === 'nav:go-to-project') continue
      expect(resolveEffectiveBinding(shortcut.id, custom)).toEqual(shortcut.defaultBinding)
    }
  })
})
