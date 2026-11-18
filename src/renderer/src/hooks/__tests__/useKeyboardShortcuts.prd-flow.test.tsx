import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShortcutStore } from '@/stores/useShortcutStore'

// Cmd/Ctrl+W with the form of "New PRD → orchestrator ticket…" open: the key closes the form,
// as it closes the "Implement document" wizard, and not the file tab or the session behind
// it. While "Start" is in flight (the dialog is marked data-starting) it closes nothing at
// all: the form stays to say whether the flow started. Both ways the key arrives are covered:
// forwarded by the main process (the menu shortcut) and as a keydown.

// useKeyboardShortcuts side effects (same set as the document-flow shortcut tests)
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

const initialPrdFlowState = usePrdFlowStore.getState()
const initialFlowState = useDocumentFlowStore.getState()
const initialFileViewerState = useFileViewerStore.getState()
const initialSessionState = useSessionStore.getState()

const FILE_TAB = '/repo/shop/README.md'

/**
 * The global shortcut listener next to the form as PrdFlowDialog draws it: its content carries
 * the test id, and data-starting while "Start" is in flight.
 */
function Harness({ starting = false }: { starting?: boolean }): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <div data-testid="prd-flow-dialog" data-starting={starting ? '' : undefined}>
      <input data-testid="prd-flow-name-input" />
    </div>
  )
}

const closeSession = vi.fn(async () => ({ success: true }))
/** What the key does to the file tab behind the form when nothing takes it first. */
const requestCloseFile = vi.fn()

const formOpen = (): boolean => usePrdFlowStore.getState().dialog.open
/** Cmd+W as the main process forwards it from the application menu. */
const menuShortcut = (): void => onCloseSessionShortcut.mock.calls[0][0]()

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useSessionStore.setState({ activeSessionId: 'session-behind', closeSession } as never)
  // A file tab is what the key would close if the form did not take it.
  useFileViewerStore.setState({ activeFilePath: FILE_TAB, requestCloseFile } as never)
  usePrdFlowStore.getState().openDialog('project-1')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
  useFileViewerStore.setState(initialFileViewerState, true)
  useSessionStore.setState(initialSessionState, true)
})

describe('Cmd+W with the "New PRD → orchestrator ticket" form open', () => {
  it('closes the form, and neither the file tab nor the session behind it (menu shortcut)', () => {
    render(<Harness />)

    menuShortcut()

    expect(formOpen()).toBe(false)
    // The project the form was for is kept while it closes, as on Cancel.
    expect(usePrdFlowStore.getState().dialog.projectId).toBe('project-1')
    expect(requestCloseFile).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes the form from a field inside it (keydown path)', () => {
    const view = render(<Harness />)
    const field = view.getByTestId('prd-flow-name-input')
    field.focus()

    fireEvent.keyDown(field, { key: 'w', metaKey: true })

    expect(formOpen()).toBe(false)
    expect(requestCloseFile).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes nothing while "Start" is in flight: not the form, not what is behind it', () => {
    const view = render(<Harness starting />)

    menuShortcut()
    fireEvent.keyDown(view.getByTestId('prd-flow-name-input'), { key: 'w', metaKey: true })

    expect(formOpen()).toBe(true)
    expect(requestCloseFile).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes the "Implement document" wizard first when both are open, then the form', () => {
    useDocumentFlowStore.setState({
      wizard: { open: true, projectId: 'project-1', runId: null }
    })
    render(<Harness />)

    menuShortcut()
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    expect(formOpen()).toBe(true)

    menuShortcut()
    expect(formOpen()).toBe(false)
    expect(requestCloseFile).not.toHaveBeenCalled()
  })

  it('goes back to closing the file tab once the form is closed', () => {
    render(<Harness />)

    menuShortcut()
    expect(requestCloseFile).not.toHaveBeenCalled()

    menuShortcut()
    expect(requestCloseFile).toHaveBeenCalledExactlyOnceWith(FILE_TAB)
    expect(closeSession).not.toHaveBeenCalled()
  })
})
