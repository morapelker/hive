import { beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ mac: true }))
vi.mock('@/lib/platform', () => ({ isMac: () => platform.mac }))

import { buildArchiveOverrideGhostChip, isArchiveOverrideChord } from './useArchiveOverrideDrag'

const keys = (held: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...held
})

describe('isArchiveOverrideChord', () => {
  beforeEach(() => {
    platform.mac = true
  })

  it('is ⌘⇧ on macOS', () => {
    expect(isArchiveOverrideChord(keys({ metaKey: true, shiftKey: true }))).toBe(true)
    expect(isArchiveOverrideChord(keys({ metaKey: true }))).toBe(false)
    expect(isArchiveOverrideChord(keys({ shiftKey: true }))).toBe(false)
  })

  it('is never Ctrl on macOS: a Ctrl-click opens the context menu there', () => {
    expect(isArchiveOverrideChord(keys({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isArchiveOverrideChord(keys({ ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(false)
  })

  it('is Ctrl+Shift elsewhere', () => {
    platform.mac = false

    expect(isArchiveOverrideChord(keys({ ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isArchiveOverrideChord(keys({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isArchiveOverrideChord(keys({ ctrlKey: true }))).toBe(false)
  })
})

describe('buildArchiveOverrideGhostChip', () => {
  it('says what a release does', () => {
    const chip = buildArchiveOverrideGhostChip()

    expect(chip.getAttribute('data-testid')).toBe('archive-override-drag-chip')
    expect([...chip.children].map((part) => part.textContent)).toEqual([
      'Archive all',
      'no branch checks'
    ])
  })
})
