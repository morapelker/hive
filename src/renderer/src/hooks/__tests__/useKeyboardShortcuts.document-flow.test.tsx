import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShortcutStore } from '@/stores/useShortcutStore'

// useKeyboardShortcuts side effects (same set as the agent panel and force-board-mode tests)
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

const initialFlowState = useDocumentFlowStore.getState()
const initialSessionState = useSessionStore.getState()

/** The global shortcut listener next to a field inside a document-flow dialog and one outside. */
function Harness(): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <>
      <div data-docflow-dialog="">
        <input data-testid="dialog-field" />
      </div>
      <input data-testid="outside-field" />
    </>
  )
}

const toggleSessionMode = vi.fn()
const toggleSuperPlanShortcut = vi.fn()
const closeSession = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useSessionStore.setState({
    activeSessionId: 'session-behind',
    toggleSessionMode,
    toggleSuperPlanShortcut,
    closeSession
  } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useSessionStore.setState(initialSessionState, true)
})

describe('Tab inside a document-flow dialog', () => {
  it('moves focus instead of toggling the mode of the session behind the dialog', () => {
    render(<Harness />)
    const field = screen.getByTestId('dialog-field')
    field.focus()

    const tab = fireEvent.keyDown(field, { key: 'Tab' })
    const shiftTab = fireEvent.keyDown(field, { key: 'Tab', shiftKey: true })

    // Not prevented: the browser (or Radix's focus trap) moves focus as usual.
    expect(tab).toBe(true)
    expect(shiftTab).toBe(true)
    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('still toggles the session mode from a field outside the dialogs', () => {
    render(<Harness />)
    const field = screen.getByTestId('outside-field')
    field.focus()

    const tab = fireEvent.keyDown(field, { key: 'Tab' })

    expect(tab).toBe(false)
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })
})

describe('Cmd+W with a document-flow dialog open', () => {
  it('closes the run dashboard, then the wizard, and never the session (menu shortcut)', () => {
    useDocumentFlowStore.setState({
      dashboardRunId: 'run-1',
      wizard: { open: true, projectId: 'project-1', runId: null }
    })
    render(<Harness />)
    const closeShortcut = onCloseSessionShortcut.mock.calls[0][0]

    closeShortcut()
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    expect(useDocumentFlowStore.getState().wizard.open).toBe(true)
    expect(closeSession).not.toHaveBeenCalled()

    closeShortcut()
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    expect(closeSession).not.toHaveBeenCalled()

    closeShortcut()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('leaves the active session open on the keydown path too', () => {
    render(<Harness />)

    fireEvent.keyDown(document.body, { key: 'w', metaKey: true })

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes the wizard from a field inside it (keydown path) and leaves the session alone', () => {
    useDocumentFlowStore.setState({
      wizard: { open: true, projectId: 'project-1', runId: null }
    })
    render(<Harness />)
    const field = screen.getByTestId('dialog-field')
    field.focus()

    fireEvent.keyDown(field, { key: 'w', metaKey: true })

    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    expect(closeSession).not.toHaveBeenCalled()
  })
})
