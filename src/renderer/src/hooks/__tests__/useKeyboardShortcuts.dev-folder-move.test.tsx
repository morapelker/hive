// Cmd+W with the "Move projects" dialog open. The dialog is opened from Settings and drawn
// over it: the key closes the dialog first, and while projects are being moved it closes
// nothing at all, where it used to close Settings under the dialog and then the tabs behind.
// The real move flow and its store; both ways the key arrives (the menu shortcut the main
// process forwards, and a keydown).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

// useKeyboardShortcuts side effects (same set as the document-flow and agent panel tests)
vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn()),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: false })
  }
}))
vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn().mockResolvedValue(undefined) }
}))
const onCloseSessionShortcut = vi.hoisted(() => vi.fn((_listener: () => void) => vi.fn()))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: vi.fn(() => vi.fn()),
    onFileSearchShortcut: vi.fn(() => vi.fn()),
    onCloseSessionShortcut,
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import {
  CLOSED_DEV_FOLDER_MOVE,
  useDevFolderMoveStore,
  type DevFolderMovePhase
} from '@/lib/dev-folder/store'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useShortcutStore } from '@/stores/useShortcutStore'

const FILE_BEHIND = '/Users/me/Dev/api/README.md'

function Harness(): null {
  useKeyboardShortcuts()
  return null
}

const requestCloseFile = vi.fn()
const closeDiffTab = vi.fn()
const initialFileViewerState = useFileViewerStore.getState()

/** The two ways Cmd+W reaches the window. */
const WAYS: [string, () => void][] = [
  ['the menu shortcut', () => onCloseSessionShortcut.mock.calls[0][0]()],
  ['a keydown', () => void fireEvent.keyDown(document.body, { key: 'w', metaKey: true })]
]

/** Settings open with the dialog over it, and a file tab behind both. */
const openOverSettings = (phase: DevFolderMovePhase): void => {
  useSettingsStore.setState({ isOpen: true })
  useDevFolderMoveStore.setState({ phase })
}

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useFileViewerStore.setState({
    activeFilePath: FILE_BEHIND,
    requestCloseFile,
    closeDiffTab
  } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  useSettingsStore.setState({ isOpen: false })
  useFileViewerStore.setState(initialFileViewerState, true)
})

describe.each(WAYS)('Cmd+W with "Move projects" open (%s)', (_way, pressCloseShortcut) => {
  it('closes nothing while projects are being moved, however often it is pressed', () => {
    openOverSettings('running')
    render(<Harness />)

    pressCloseShortcut()
    pressCloseShortcut()
    pressCloseShortcut()

    expect(useDevFolderMoveStore.getState().phase).toBe('running')
    expect(useSettingsStore.getState().isOpen).toBe(true)
    expect(requestCloseFile).not.toHaveBeenCalled()
    expect(closeDiffTab).not.toHaveBeenCalled()
  })

  it.each(['planning', 'confirm', 'summary'] as const)(
    'closes the dialog in "%s" and leaves Settings open; the next one closes Settings',
    (phase) => {
      openOverSettings(phase)
      render(<Harness />)

      pressCloseShortcut()
      expect(useDevFolderMoveStore.getState()).toEqual(CLOSED_DEV_FOLDER_MOVE)
      expect(useSettingsStore.getState().isOpen).toBe(true)
      expect(requestCloseFile).not.toHaveBeenCalled()

      pressCloseShortcut()
      expect(useSettingsStore.getState().isOpen).toBe(false)
      expect(requestCloseFile).not.toHaveBeenCalled()

      // Nothing is open any more: the key is the file tab's again.
      pressCloseShortcut()
      expect(requestCloseFile).toHaveBeenCalledTimes(1)
      expect(requestCloseFile).toHaveBeenCalledWith(FILE_BEHIND)
    }
  )
})
