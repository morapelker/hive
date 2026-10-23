// While a data project (database client) owns the main pane, the session, worktree and file tabs
// behind it are not on screen, yet the session store still points at the hidden worktree's
// session. Nothing may act on them: Tab / Shift+Tab move focus in the client's forms (a typed
// confirmation, a filter value, the assistant composer…) instead of flipping the hidden session's
// mode, Cmd+T / Cmd+D / Cmd+W forwarded by the main process neither create a session, open file
// search nor close a hidden file tab, git keys never push the hidden worktree and the menu shows
// no active session. Next / previous project walks the merged sidebar, data projects included.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SESSION_SCOPED_SHORTCUTS, useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useGitStore } from '@/stores/useGitStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn()),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: false })
  }
}))
vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    project: { touch: vi.fn().mockResolvedValue(undefined) },
    worktree: { touch: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn().mockResolvedValue(undefined) }
}))
vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    touch: vi.fn().mockResolvedValue(undefined),
    onStatus: vi.fn(() => vi.fn())
  }
}))
const forwarded = vi.hoisted(() => ({
  newSession: [] as Array<() => void>,
  fileSearch: [] as Array<() => void>,
  closeTab: [] as Array<() => void>,
  updateMenuState: vi.fn()
}))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: (cb: () => void) => (forwarded.newSession.push(cb), vi.fn()),
    onFileSearchShortcut: (cb: () => void) => (forwarded.fileSearch.push(cb), vi.fn()),
    onCloseSessionShortcut: (cb: () => void) => (forwarded.closeTab.push(cb), vi.fn()),
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: (...args: unknown[]) => {
      forwarded.updateMenuState(...args)
      return Promise.resolve()
    }
  }
}))
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))

const initial = {
  session: useSessionStore.getState(),
  data: useDataProjectStore.getState(),
  project: useProjectStore.getState(),
  worktree: useWorktreeStore.getState(),
  connection: useConnectionStore.getState(),
  fileViewer: useFileViewerStore.getState(),
  fileSearch: useFileSearchStore.getState(),
  git: useGitStore.getState(),
  settings: useSettingsStore.getState()
}

/** The fields of a data project's forms and dialogs: none is an editor or grid. */
function Harness(): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <>
      <input data-testid="typed-confirmation" />
      <textarea data-testid="assistant-composer" />
      <button type="button" data-testid="toolbar-button">
        History
      </button>
    </>
  )
}

const toggleSessionMode = vi.fn()
const toggleSuperPlanShortcut = vi.fn()
const createSession = vi.fn(async () => ({ success: true }))
const requestCloseFile = vi.fn()
const push = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  forwarded.newSession.length = 0
  forwarded.fileSearch.length = 0
  forwarded.closeTab.length = 0
  useShortcutStore.setState({ customBindings: {} })
  // A worktree with a session was open, then the data project was selected.
  useSessionStore.setState({
    activeSessionId: 'session-behind',
    activeWorktreeId: 'wt-behind',
    toggleSessionMode,
    toggleSuperPlanShortcut,
    createSession
  } as never)
  useWorktreeStore.setState({
    selectedWorktreeId: null,
    worktreesByProject: new Map([['p-behind', [{ id: 'wt-behind', path: '/repo/behind' }]]])
  } as never)
  useFileViewerStore.setState({ activeFilePath: '/repo/behind/a.ts', requestCloseFile } as never)
  useGitStore.setState({ push, isPushing: false } as never)
  useDataProjectStore.setState({ projects: [sampleDataProject()], selectedDataProjectId: 'dp-1' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSessionStore.setState(initial.session, true)
  useDataProjectStore.setState(initial.data, true)
  useProjectStore.setState(initial.project, true)
  useWorktreeStore.setState(initial.worktree, true)
  useConnectionStore.setState(initial.connection, true)
  useFileViewerStore.setState(initial.fileViewer, true)
  useFileSearchStore.setState(initial.fileSearch, true)
  useGitStore.setState(initial.git, true)
  useSettingsStore.setState(initial.settings, true)
})

describe('Tab and Shift+Tab with a data project open', () => {
  it('move focus in its fields and never toggle the hidden session', () => {
    render(<Harness />)
    for (const id of ['typed-confirmation', 'assistant-composer', 'toolbar-button']) {
      const field = screen.getByTestId(id)
      field.focus()
      expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true)
      expect(fireEvent.keyDown(field, { key: 'Tab', shiftKey: true })).toBe(true)
    }
    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('toggle the session again once a worktree is back on screen', () => {
    render(<Harness />)
    act(() => useDataProjectStore.setState({ selectedDataProjectId: null }))
    expect(fireEvent.keyDown(screen.getByTestId('typed-confirmation'), { key: 'Tab' })).toBe(false)
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })

  it('cover every session-scoped shortcut, and the git ones never reach the hidden worktree', () => {
    expect(SESSION_SCOPED_SHORTCUTS.has('session:mode-toggle')).toBe(true)
    expect(SESSION_SCOPED_SHORTCUTS.has('session:super-plan-toggle')).toBe(true)
    render(<Harness />)
    // ⌘⇧P (git:push) from a non-input element.
    fireEvent.keyDown(screen.getByTestId('toolbar-button'), {
      key: 'p',
      metaKey: true,
      shiftKey: true
    })
    // ⌘] / ⌘[ (next / previous session) and ⌥T (model variant).
    fireEvent.keyDown(screen.getByTestId('toolbar-button'), { key: ']', metaKey: true })
    expect(push).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeSessionId).toBe('session-behind')
  })
})

describe('shortcuts forwarded by the main process with a data project open', () => {
  it('Cmd+T creates no session (DataProjectView opens a query tab)', () => {
    render(<Harness />)
    forwarded.newSession.forEach((cb) => cb())
    expect(createSession).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('Cmd+D does not open file search', () => {
    render(<Harness />)
    forwarded.fileSearch.forEach((cb) => cb())
    expect(useFileSearchStore.getState().isOpen).toBe(false)
  })

  it('Cmd+W closes an open modal but never a hidden file tab', () => {
    render(<Harness />)
    useFileSearchStore.setState({ isOpen: true })
    forwarded.closeTab.forEach((cb) => cb())
    expect(useFileSearchStore.getState().isOpen).toBe(false)

    forwarded.closeTab.forEach((cb) => cb())
    expect(requestCloseFile).not.toHaveBeenCalled()

    // Back on the worktree, Cmd+W closes its file tab as before.
    act(() => useDataProjectStore.setState({ selectedDataProjectId: null }))
    forwarded.closeTab.forEach((cb) => cb())
    expect(requestCloseFile).toHaveBeenCalledWith('/repo/behind/a.ts')
  })

  it('the application menu shows no active session', () => {
    render(<Harness />)
    expect(forwarded.updateMenuState).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasActiveSession: false, hasActiveWorktree: false })
    )
  })
})

describe('next / previous project', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [sampleGitProject('Pa', 1), sampleGitProject('Pb', 2)] as never,
      selectedProjectId: null
    })
    useDataProjectStore.setState({
      projects: [
        sampleDataProject({ id: 'D1', name: 'orders', sortOrder: 0 }),
        sampleDataProject({ id: 'D2', name: 'cache', sortOrder: 3 })
      ],
      selectedDataProjectId: 'D1'
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['Pa', []],
        ['Pb', []]
      ])
    } as never)
    useConnectionStore.setState({ connections: [], selectedConnectionId: null })
  })

  const next = (): void => {
    fireEvent.keyDown(document.body, {
      key: ']',
      code: 'BracketRight',
      metaKey: true,
      altKey: true
    })
  }
  const previous = (): void => {
    fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft', metaKey: true, altKey: true })
  }
  const selection = (): [string | null, string | null] => [
    useDataProjectStore.getState().selectedDataProjectId,
    useProjectStore.getState().selectedProjectId
  ]

  it('walks the merged sidebar order and lands on data projects too', () => {
    render(<Harness />)
    next()
    expect(selection()).toEqual([null, 'Pa'])
    next()
    expect(selection()).toEqual([null, 'Pb'])
    next()
    expect(selection()).toEqual(['D2', null])
    next()
    expect(selection()).toEqual(['D1', null])
    previous()
    expect(selection()).toEqual(['D2', null])
  })
})
