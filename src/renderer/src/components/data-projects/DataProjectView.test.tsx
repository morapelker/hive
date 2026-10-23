// The open data project: connecting / failed / password needed / removed states before the
// workspace, the workspace staying mounted (with a banner) when an established connection
// drops, the toolbar (environment bar, safe-mode menu with the production confirmation,
// Processes / History, assistant toggle incl. ⌘⇧J), the view's keyboard (new tab, tab cycling,
// table views, ⌘D handed back to the editor) and reconnecting after a settings change.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataConnectionStatus, DataProject } from '@shared/data-projects/types'
import { sampleDataProject } from './data-project.sample'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { searchKeymap } from '@codemirror/search'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  update: vi.fn(),
  touch: vi.fn(),
  onStatus: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))

const host = vi.hoisted(() => ({
  openWorkspaceSpecialTab: vi.fn(),
  openWorkspaceNewTab: vi.fn(),
  cycleWorkspaceTab: vi.fn(),
  stepWorkspaceView: vi.fn(),
  sendTableCommand: vi.fn()
}))
vi.mock('./DataProjectWorkspaceHost', () => ({
  DataProjectWorkspace: ({ project }: { project: DataProject }) => (
    <div data-testid="workspace" data-project-id={project.id}>
      <div data-db-editor="">
        <div contentEditable suppressContentEditableWarning tabIndex={0} data-testid="editor">
          select 1
        </div>
      </div>
      <button type="button" data-testid="workspace-button">
        Refresh
      </button>
    </div>
  ),
  DataProjectConfirmHost: () => <div data-testid="confirm-host" />,
  openWorkspaceSpecialTab: host.openWorkspaceSpecialTab,
  openWorkspaceNewTab: host.openWorkspaceNewTab,
  cycleWorkspaceTab: host.cycleWorkspaceTab,
  stepWorkspaceView: host.stepWorkspaceView,
  sendTableCommand: host.sendTableCommand
}))
// ⌘T / ⌘D forwarded by the main process (Electron swallows the keydowns).
const forwarded = vi.hoisted(() => ({
  newTab: new Set<() => void>(),
  fileSearch: new Set<() => void>()
}))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: (cb: () => void) => {
      forwarded.newTab.add(cb)
      return () => forwarded.newTab.delete(cb)
    },
    onFileSearchShortcut: (cb: () => void) => {
      forwarded.fileSearch.add(cb)
      return () => forwarded.fileSearch.delete(cb)
    }
  }
}))
vi.mock('@/lib/platform', () => ({ isMac: () => true, isWindows: () => false }))
vi.mock('./assistant/DataAssistantPanel', () => ({
  DataAssistantPanel: ({ onClose }: { onClose: () => void }) => (
    <button type="button" data-testid="assistant-panel" onClick={onClose} />
  )
}))
vi.mock('@/api/project-api', () => ({
  projectApi: { getProjectIconPath: vi.fn(async () => null), copyToClipboard: vi.fn() }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { default: DataProjectView } = await import('./DataProjectView')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')

const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})
afterAll(() => {
  Element.prototype.matches = originalMatches
})

let statusListener: ((status: DataConnectionStatus) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
  api.touch.mockResolvedValue(undefined)
  api.list.mockResolvedValue([])
  api.status.mockImplementation(async (id: string) => ({
    dataProjectId: id,
    state: 'disconnected'
  }))
  api.onStatus.mockImplementation((cb: (status: DataConnectionStatus) => void) => {
    statusListener = cb
    return () => {}
  })
  api.update.mockImplementation(async (id: string, patch: Partial<DataProject>) => ({
    ...useDataProjectStore.getState().projects.find((p) => p.id === id)!,
    ...patch
  }))
  host.openWorkspaceSpecialTab.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

function setup(overrides: Partial<DataProject> = {}): DataProject {
  const project = sampleDataProject(overrides)
  useDataProjectStore.setState({ projects: [project], loaded: true })
  render(<DataProjectView projectId={project.id} />)
  return project
}

describe('states', () => {
  it('shows "removed" for a project that no longer exists', async () => {
    useDataProjectStore.setState({ loaded: true, selectedDataProjectId: 'gone' })
    render(<DataProjectView projectId="gone" />)
    expect(screen.getByTestId('data-project-removed')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('data-project-removed-close'))
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('offers Retry when the list could not be loaded', async () => {
    api.list.mockRejectedValueOnce(new Error('backend unavailable'))
    render(<DataProjectView projectId="dp-1" />)
    expect(await screen.findByTestId('data-project-load-error')).toHaveTextContent(
      'backend unavailable'
    )
    api.list.mockResolvedValueOnce([sampleDataProject()])
    api.connect.mockReturnValue(new Promise(() => {}))
    await userEvent.click(screen.getByTestId('data-project-load-retry'))
    expect(await screen.findByTestId('data-project-connecting')).toBeInTheDocument()
  })

  it('loads the list first when it was never loaded', async () => {
    api.list.mockResolvedValue([sampleDataProject()])
    api.connect.mockReturnValue(new Promise(() => {}))
    render(<DataProjectView projectId="dp-1" />)
    expect(screen.getByTestId('data-project-loading')).toBeInTheDocument()
    expect(await screen.findByTestId('data-project-connecting')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalled()
  })

  it('connects on open and shows a spinner meanwhile', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup()
    expect(await screen.findByTestId('data-project-connecting')).toHaveTextContent(
      'Connecting to localhost / shop'
    )
    expect(api.connect).toHaveBeenCalledWith('dp-1')
    expect(screen.getByTestId('data-project-toolbar')).toBeInTheDocument()
  })

  it('shows a failed connection with the message, a hint and Retry', async () => {
    api.connect.mockRejectedValueOnce(
      Object.assign(new Error('password authentication failed for user "postgres"'), {
        name: 'DATA_CONNECTION_FAILED'
      })
    )
    setup()
    expect(await screen.findByTestId('data-project-connection-error')).toHaveTextContent(
      'The server rejected the user name or password.'
    )
    expect(screen.getByTestId('data-project-connection-error-message')).toHaveTextContent(
      'password authentication failed'
    )
    api.connect.mockResolvedValueOnce({ dataProjectId: 'dp-1', state: 'connected' })
    await userEvent.click(screen.getByTestId('data-project-state-retry'))
    expect(await screen.findByTestId('workspace')).toBeInTheDocument()
  })

  it('asks for the password when the server has none it can use', async () => {
    api.connect.mockRejectedValue(
      Object.assign(new Error('Saved password cannot be read on this Mac'), {
        name: 'DATA_CREDENTIALS_REQUIRED'
      })
    )
    setup()
    expect(await screen.findByTestId('data-project-credentials-needed')).toHaveTextContent(
      'Saved password cannot be read on this Mac'
    )
    expect(useDataProjectStore.getState().credentialsPrompt?.projectId).toBe('dp-1')
    act(() => useDataProjectStore.getState().closeCredentialsPrompt())
    await userEvent.click(screen.getByTestId('data-project-state-enter-credentials'))
    expect(useDataProjectStore.getState().credentialsPrompt?.projectId).toBe('dp-1')
  })

  it('keeps the workspace after a drop and offers Reconnect in a banner', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    expect(await screen.findByTestId('workspace')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-host')).toBeInTheDocument()

    act(() => {
      useDataProjectStore
        .getState()
        .applyStatus({ dataProjectId: 'dp-1', state: 'error', error: 'connect ETIMEDOUT' })
    })
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-connection-lost')).toHaveTextContent('Connection lost.')

    await userEvent.click(screen.getByTestId('data-project-reconnect'))
    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByTestId('data-project-connection-lost')).not.toBeInTheDocument()
    )
  })

  it('an idle disconnect is silent', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    await screen.findByTestId('workspace')
    act(() => statusListener?.({ dataProjectId: 'dp-1', state: 'disconnected' }))
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('data-project-connection-lost')).not.toBeInTheDocument()
  })

  it('reconnects after the connection settings changed', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    await screen.findByTestId('workspace')
    expect(api.connect).toHaveBeenCalledTimes(1)

    await act(async () => {
      await useDataProjectStore.getState().update('dp-1', { config: { host: 'db2' } })
    })
    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2))
  })
})

describe('toolbar', () => {
  it('marks production with a thick bar and a badge', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup({ environment: 'production', safeMode: 'half-safe' })
    expect(screen.getByTestId('data-project-environment-bar')).toHaveAttribute(
      'data-environment',
      'production'
    )
    expect(screen.getByTestId('data-project-environment-badge-large')).toHaveTextContent(
      'Production'
    )
    expect(screen.getByTestId('data-project-safe-mode-trigger')).toHaveAttribute(
      'data-safe-mode',
      'half-safe'
    )
  })

  it('confirms before loosening safe mode on production', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup({ environment: 'production', safeMode: 'half-safe' })

    await userEvent.click(screen.getByTestId('data-project-safe-mode-trigger'))
    await userEvent.click(await screen.findByTestId('data-project-safe-mode-off'))
    expect(await screen.findByTestId('data-project-safe-mode-confirm')).toBeInTheDocument()
    expect(api.update).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('data-project-safe-mode-confirm-cancel'))
    expect(api.update).not.toHaveBeenCalled()
  })

  it('changes safe mode at once elsewhere', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup({ environment: 'development', safeMode: 'half-safe' })

    await userEvent.click(screen.getByTestId('data-project-safe-mode-trigger'))
    await userEvent.click(await screen.findByTestId('data-project-safe-mode-off'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('dp-1', { safeMode: 'off' }))
  })

  it('opens Processes and History in the workspace', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    const project = setup()
    await userEvent.click(screen.getByTestId('data-project-processes'))
    await userEvent.click(screen.getByTestId('data-project-history'))
    expect(host.openWorkspaceSpecialTab).toHaveBeenNthCalledWith(1, project, 'processes')
    expect(host.openWorkspaceSpecialTab).toHaveBeenNthCalledWith(2, project, 'history')
  })

  it('toggles the assistant from the toolbar and with ⌘⇧J', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup()
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('data-project-assistant-toggle'))
    expect(screen.getByTestId('assistant-panel')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'j', metaKey: true, shiftKey: true })
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'J', metaKey: true, shiftKey: true })
    await userEvent.click(screen.getByTestId('assistant-panel'))
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
  })

  it('opens a new query tab with ⌘T, as a keydown and when the main process forwards it', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    const project = setup()
    const editor = await screen.findByTestId('editor')

    expect(fireEvent.keyDown(editor, { key: 't', metaKey: true })).toBe(false)
    expect(host.openWorkspaceNewTab).toHaveBeenCalledTimes(1)
    expect(host.openWorkspaceNewTab).toHaveBeenCalledWith(project)

    act(() => forwarded.newTab.forEach((cb) => cb()))
    expect(host.openWorkspaceNewTab).toHaveBeenCalledTimes(2)
  })

  it('cycles tabs with ⌃Tab / ⌃⇧Tab and table views with ⌃⌘] / ⌃⌘[', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    const project = setup()
    const editor = await screen.findByTestId('editor')

    expect(fireEvent.keyDown(editor, { key: 'Tab', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(editor, { key: 'Tab', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(host.cycleWorkspaceTab.mock.calls).toEqual([
      [project, 1],
      [project, -1]
    ])

    const button = screen.getByTestId('workspace-button')
    fireEvent.keyDown(button, { key: ']', code: 'BracketRight', ctrlKey: true, metaKey: true })
    fireEvent.keyDown(button, { key: '[', code: 'BracketLeft', ctrlKey: true, metaKey: true })
    expect(host.stepWorkspaceView.mock.calls).toEqual([
      [project, 1],
      [project, -1]
    ])

    // Plain Tab and ⌘] stay with the editor (focus / indent).
    expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(editor, { key: ']', metaKey: true })).toBe(true)
    expect(host.cycleWorkspaceTab).toHaveBeenCalledTimes(2)
    expect(host.stepWorkspaceView).toHaveBeenCalledTimes(2)
  })

  it('sends ⌘R / ⌘F to the active table, and lets them pass when no view answers', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    const editor = await screen.findByTestId('editor')
    const button = screen.getByTestId('workspace-button')

    host.sendTableCommand.mockReturnValue(true)
    expect(fireEvent.keyDown(button, { key: 'r', metaKey: true })).toBe(false)
    expect(fireEvent.keyDown(button, { key: 'f', code: 'KeyF', metaKey: true })).toBe(false)
    expect(host.sendTableCommand.mock.calls).toEqual([
      [{ projectId: 'dp-1', command: 'refresh' }],
      [{ projectId: 'dp-1', command: 'filter' }]
    ])

    // ⌘F in the query editor is the editor's own search.
    expect(fireEvent.keyDown(editor, { key: 'f', code: 'KeyF', metaKey: true })).toBe(true)
    expect(host.sendTableCommand).toHaveBeenCalledTimes(2)

    // No table view took it (a query tab is active): the key goes on unchanged.
    host.sendTableCommand.mockReturnValue(false)
    expect(fireEvent.keyDown(button, { key: 'r', metaKey: true })).toBe(true)
  })

  it('hands a forwarded ⌘D back to the focused editor and ignores it elsewhere', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    const editor = await screen.findByTestId('editor')
    const received: KeyboardEvent[] = []
    editor.addEventListener('keydown', (e) => received.push(e))

    editor.focus()
    act(() => forwarded.fileSearch.forEach((cb) => cb()))
    expect(received).toHaveLength(1)
    // CodeMirror's Mod: Meta on a Mac, Ctrl elsewhere (jsdom reports no platform).
    const modIsMeta = /Mac/.test(navigator.platform)
    expect(received[0]).toMatchObject({ key: 'd', metaKey: modIsMeta, ctrlKey: !modIsMeta })

    screen.getByTestId('workspace-button').focus()
    act(() => forwarded.fileSearch.forEach((cb) => cb()))
    expect(received).toHaveLength(1)
  })

  it('runs select-next-occurrence of a real CodeMirror editor with the handed-back ⌘D', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    const host = await screen.findByTestId('editor')
    const view = new EditorView({
      state: EditorState.create({
        doc: 'select id from users where id = id',
        // "id" in "select id …": the next one is in "where id".
        selection: EditorSelection.single(7, 9),
        extensions: [
          // As in QueryEditor.
          EditorState.allowMultipleSelections.of(true),
          keymap.of(searchKeymap),
          // jsdom only focuses elements with a tab index (not a bare contenteditable).
          EditorView.contentAttributes.of({ tabindex: '0' })
        ]
      }),
      parent: host
    })
    try {
      view.contentDOM.focus()
      expect(document.activeElement).toBe(view.contentDOM)
      act(() => forwarded.fileSearch.forEach((cb) => cb()))
      expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
        [7, 9],
        [27, 29]
      ])
    } finally {
      view.destroy()
    }
  })

  it('leaves the keys alone inside a dialog open over the view', async () => {
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })
    setup()
    await screen.findByTestId('editor')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    const field = document.createElement('input')
    dialog.appendChild(field)
    document.body.appendChild(dialog)
    try {
      expect(fireEvent.keyDown(field, { key: 't', metaKey: true })).toBe(true)
      expect(fireEvent.keyDown(field, { key: 'Tab', ctrlKey: true })).toBe(true)
      act(() => forwarded.newTab.forEach((cb) => cb()))
      expect(host.openWorkspaceNewTab).not.toHaveBeenCalled()
      expect(host.cycleWorkspaceTab).not.toHaveBeenCalled()
    } finally {
      dialog.remove()
    }
  })

  it('opens the edit wizard', async () => {
    api.connect.mockReturnValue(new Promise(() => {}))
    setup()
    await userEvent.click(screen.getByTestId('data-project-edit-connection'))
    expect(useDataProjectStore.getState().wizard).toEqual({ mode: 'edit', projectId: 'dp-1' })
  })
})
