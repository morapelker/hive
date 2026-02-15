/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for menu capability gating — verifying that updateMenuState
 * correctly enables/disables undo/redo menu items based on canUndo/canRedo.
 */

// Mock menu items storage
const menuItems = new Map<string, { enabled: boolean }>()

// Build mock menu items for all known IDs
const sessionItemIds = [
  'session-toggle-mode',
  'session-cycle-model',
  'session-undo-turn',
  'session-redo-turn'
]

const worktreeItemIds = [
  'session-run-project',
  'git-commit',
  'git-push',
  'git-pull',
  'git-stage-all',
  'git-unstage-all',
  'git-open-in-editor',
  'git-open-in-terminal'
]

function resetMenuItems(): void {
  menuItems.clear()
  for (const id of [...sessionItemIds, ...worktreeItemIds]) {
    menuItems.set(id, { enabled: false })
  }
}

// Mock Electron's Menu.getApplicationMenu()
vi.mock('electron', () => ({
  Menu: {
    getApplicationMenu: vi.fn(() => ({
      getMenuItemById: (id: string) => menuItems.get(id) ?? null
    }))
  },
  BrowserWindow: vi.fn(),
  app: { getVersion: () => '1.0.0' },
  shell: { openPath: vi.fn() }
}))

// Mock dependencies of menu.ts
vi.mock('../../../src/main/services/logger', () => ({
  getLogDir: () => '/tmp/logs'
}))

vi.mock('../../../src/main/services/updater', () => ({
  updaterService: { checkForUpdates: vi.fn() }
}))

import { updateMenuState } from '../../../src/main/menu'

describe('updateMenuState with capability gating', () => {
  beforeEach(() => {
    resetMenuItems()
  })

  it('enables all session items when hasActiveSession is true (backward compat)', () => {
    updateMenuState({ hasActiveSession: true, hasActiveWorktree: false })

    expect(menuItems.get('session-toggle-mode')!.enabled).toBe(true)
    expect(menuItems.get('session-cycle-model')!.enabled).toBe(true)
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(true)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(true)
  })

  it('disables all session items when hasActiveSession is false (backward compat)', () => {
    updateMenuState({ hasActiveSession: false, hasActiveWorktree: false })

    expect(menuItems.get('session-toggle-mode')!.enabled).toBe(false)
    expect(menuItems.get('session-cycle-model')!.enabled).toBe(false)
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(false)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(false)
  })

  it('disables redo when canRedo is false, keeps undo enabled', () => {
    updateMenuState({
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: true,
      canRedo: false
    })

    expect(menuItems.get('session-toggle-mode')!.enabled).toBe(true)
    expect(menuItems.get('session-cycle-model')!.enabled).toBe(true)
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(true)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(false)
  })

  it('disables undo when canUndo is false, keeps redo enabled', () => {
    updateMenuState({
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: false,
      canRedo: true
    })

    expect(menuItems.get('session-undo-turn')!.enabled).toBe(false)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(true)
    expect(menuItems.get('session-toggle-mode')!.enabled).toBe(true)
  })

  it('disables both undo and redo when both are false', () => {
    updateMenuState({
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: false,
      canRedo: false
    })

    expect(menuItems.get('session-undo-turn')!.enabled).toBe(false)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(false)
    // Other session items still enabled
    expect(menuItems.get('session-toggle-mode')!.enabled).toBe(true)
  })

  it('enables both undo and redo when both are true', () => {
    updateMenuState({
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: true,
      canRedo: true
    })

    expect(menuItems.get('session-undo-turn')!.enabled).toBe(true)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(true)
  })

  it('falls back to hasActiveSession when canUndo/canRedo are undefined', () => {
    // Active session, no capability overrides
    updateMenuState({ hasActiveSession: true, hasActiveWorktree: false })
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(true)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(true)

    // No active session, no capability overrides
    resetMenuItems()
    updateMenuState({ hasActiveSession: false, hasActiveWorktree: false })
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(false)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(false)
  })

  it('handles worktree items independently of session capabilities', () => {
    updateMenuState({
      hasActiveSession: true,
      hasActiveWorktree: true,
      canUndo: false,
      canRedo: false
    })

    // Worktree items should be enabled based on hasActiveWorktree
    expect(menuItems.get('git-commit')!.enabled).toBe(true)
    expect(menuItems.get('git-push')!.enabled).toBe(true)
    expect(menuItems.get('session-run-project')!.enabled).toBe(true)

    // Undo/redo should be gated by capabilities
    expect(menuItems.get('session-undo-turn')!.enabled).toBe(false)
    expect(menuItems.get('session-redo-turn')!.enabled).toBe(false)
  })
})
