// Inside a data project's query editor ([data-db-editor]) or result grid ([data-db-grid]) the
// global shortcut map steps aside (Tab completes, Cmd+] indents, Cmd+D selects the next
// occurrence…) except for the app-level escapes: command palette, session history, settings and
// the Pinned Board. Vim navigation never captures Escape or normal-mode keys there either. The
// data project dialogs keep Tab for moving between fields.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DATA_CLIENT_GLOBAL_SHORTCUTS,
  isDataClientTarget,
  useKeyboardShortcuts
} from '@/hooks/useKeyboardShortcuts'
import { useVimNavigation } from '@/hooks/useVimNavigation'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useVimModeStore } from '@/stores/useVimModeStore'

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
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: vi.fn(() => vi.fn()),
    onFileSearchShortcut: vi.fn(() => vi.fn()),
    onCloseSessionShortcut: vi.fn(() => vi.fn()),
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const initialSession = useSessionStore.getState()
const initialKanban = useKanbanStore.getState()
const initialPalette = useCommandPaletteStore.getState()
const initialSettings = useSettingsStore.getState()
const initialVim = useVimModeStore.getState()

function Harness({ vim = false }: { vim?: boolean }): React.JSX.Element {
  useKeyboardShortcuts()
  if (vim) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed per render in each test
    useVimNavigation()
  }
  return (
    <>
      <div data-db-editor="">
        <div contentEditable suppressContentEditableWarning data-testid="db-editor">
          select 1
        </div>
      </div>
      <div data-db-grid="" tabIndex={0} data-testid="db-grid" />
      <div data-db-dialog="">
        <input data-testid="db-dialog-field" />
      </div>
      <input data-testid="outside-field" />
    </>
  )
}

const toggleSessionMode = vi.fn()
const togglePinnedBoard = vi.fn()

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useSessionStore.setState({ activeSessionId: 'session-behind', toggleSessionMode } as never)
  useKanbanStore.setState({ togglePinnedBoard } as never)
  useCommandPaletteStore.setState({ isOpen: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSessionStore.setState(initialSession, true)
  useKanbanStore.setState(initialKanban, true)
  useCommandPaletteStore.setState(initialPalette, true)
  useSettingsStore.setState(initialSettings, true)
  useVimModeStore.setState(initialVim, true)
})

describe('isDataClientTarget', () => {
  it('matches elements inside the editor or the grid only', () => {
    render(<Harness />)
    expect(isDataClientTarget(screen.getByTestId('db-editor'))).toBe(true)
    expect(isDataClientTarget(screen.getByTestId('db-grid'))).toBe(true)
    expect(isDataClientTarget(screen.getByTestId('outside-field'))).toBe(false)
    expect(isDataClientTarget(null)).toBe(false)
    expect(isDataClientTarget(document)).toBe(false)
  })

  it('keeps exactly the four app-level shortcuts global', () => {
    expect([...DATA_CLIENT_GLOBAL_SHORTCUTS].sort()).toEqual([
      'nav:command-palette',
      'nav:session-history',
      'nav:toggle-pinned-board',
      'settings:open'
    ])
  })
})

describe('global shortcuts inside the database client', () => {
  it('leaves Tab to the editor (completion / indent)', () => {
    render(<Harness />)
    const editor = screen.getByTestId('db-editor')
    expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(true)
    expect(toggleSessionMode).not.toHaveBeenCalled()

    // Outside the client, Tab still toggles the session mode.
    expect(fireEvent.keyDown(screen.getByTestId('outside-field'), { key: 'Tab' })).toBe(false)
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })

  it('leaves Cmd+] / Cmd+D to the editor and the grid', () => {
    render(<Harness />)
    expect(fireEvent.keyDown(screen.getByTestId('db-editor'), { key: ']', metaKey: true })).toBe(
      true
    )
    expect(fireEvent.keyDown(screen.getByTestId('db-grid'), { key: 'd', metaKey: true })).toBe(true)
  })

  it('still opens the command palette and toggles the Pinned Board', () => {
    render(<Harness />)
    const editor = screen.getByTestId('db-editor')

    expect(fireEvent.keyDown(editor, { key: 'o', metaKey: true })).toBe(false)
    expect(useCommandPaletteStore.getState().isOpen).toBe(true)

    expect(fireEvent.keyDown(editor, { key: 'p', metaKey: true })).toBe(false)
    expect(togglePinnedBoard).toHaveBeenCalledTimes(1)
  })

  it('lets Tab move between the fields of the data project dialogs', () => {
    render(<Harness />)
    expect(fireEvent.keyDown(screen.getByTestId('db-dialog-field'), { key: 'Tab' })).toBe(true)
    expect(toggleSessionMode).not.toHaveBeenCalled()
  })
})

describe('vim navigation inside the database client', () => {
  it('never turns Escape in the editor into normal mode', () => {
    useSettingsStore.setState({ vimModeEnabled: true })
    useVimModeStore.setState({ mode: 'insert' })
    render(<Harness vim />)

    const escape = fireEvent.keyDown(screen.getByTestId('db-editor'), { key: 'Escape' })

    expect(escape).toBe(true)
    expect(useVimModeStore.getState().mode).toBe('insert')
  })

  it('still switches to normal mode from an ordinary input', () => {
    useSettingsStore.setState({ vimModeEnabled: true })
    useVimModeStore.setState({ mode: 'insert' })
    render(<Harness vim />)

    fireEvent.keyDown(screen.getByTestId('outside-field'), { key: 'Escape' })

    expect(useVimModeStore.getState().mode).toBe('normal')
  })
})
