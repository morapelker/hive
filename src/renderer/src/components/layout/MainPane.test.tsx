import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainPane } from './MainPane'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'

vi.mock('@/components/sessions', () => ({
  SessionTabs: () => <div data-testid="session-tabs" />,
  SessionView: ({
    sessionId,
    isVisible
  }: {
    sessionId: string
    isVisible?: boolean
  }) => (
    <div data-testid={`session-view-${sessionId}`} data-visible={String(isVisible)}>
      session {sessionId}
    </div>
  )
}))

vi.mock('@/components/sessions/SessionTerminalView', () => ({
  SessionTerminalView: ({
    sessionId,
    isVisible
  }: {
    sessionId: string
    isVisible?: boolean
  }) => (
    <div data-testid={`terminal-view-${sessionId}`} data-visible={String(isVisible)}>
      terminal {sessionId}
    </div>
  )
}))

vi.mock('@/components/kanban/KanbanBoard', () => ({
  KanbanBoard: () => <div data-testid="kanban-board" />
}))

vi.mock('@/components/kanban/KanbanIcon', () => ({
  KanbanIcon: () => <span data-testid="kanban-icon" />
}))

vi.mock('@/components/kanban/BoardAssistantView', () => ({
  BoardAssistantView: ({ projectId }: { projectId: string }) => (
    <div data-testid="board-assistant-view">{projectId}</div>
  )
}))

vi.mock('@/components/pr/PRNotificationStack', () => ({
  PRNotificationStack: () => null
}))

vi.mock('./MainPaneTerminalPanel', () => ({
  MainPaneTerminalPanel: () => null
}))

vi.mock('@/components/diff/MonacoDiffView', () => ({
  default: ({ worktreePath, compareBranch }: { worktreePath: string; compareBranch?: string }) => (
    <div data-testid="monaco-diff-view" data-worktree={worktreePath} data-branch={compareBranch} />
  )
}))

const initialConnectionState = useConnectionStore.getState()
const initialFileViewerState = useFileViewerStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialLayoutState = useLayoutStore.getState()
const initialPinnedState = usePinnedStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSessionState = useSessionStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

type MainPaneSession = {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  claude_session_id: string | null
  agent_sdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
  mode: 'build' | 'plan' | 'super-plan'
  session_type: 'default' | 'board-assistant' | 'shell-command'
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function makeSession(overrides: Partial<MainPaneSession> = {}): MainPaneSession {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Claude CLI',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    ...overrides
  }
}

function setupMainPaneState(session: MainPaneSession = makeSession()): void {
  useConnectionStore.setState({
    selectedConnectionId: null,
    loaded: true
  })
  useFileViewerStore.setState({
    activeFilePath: null,
    activeDiff: null,
    contextEditorWorktreeId: null
  })
  useKanbanStore.setState({
    isBoardViewActive: false,
    isPinnedBoardActive: false
  })
  useLayoutStore.setState({
    ghosttyOverlaySuppressed: false
  })
  usePinnedStore.setState({
    loaded: true
  })
  useProjectStore.setState({
    selectedProjectId: 'project-1',
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/repo',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  useSessionStore.setState({
    activeSessionId: session.id,
    activePinnedSessionId: null,
    activeBoardAssistantProjectId: null,
    inlineConnectionSessionId: null,
    isLoading: false,
    closedTerminalSessionIds: new Set(),
    sessionsByWorktree: new Map([['worktree-1', [session]]]),
    sessionsByConnection: new Map()
  })
  useSettingsStore.setState({
    boardMode: 'toggle',
    terminalPosition: 'sidebar'
  })
  useWorktreeStore.setState({
    selectedWorktreeId: 'worktree-1'
  })
}

function renderMainPane(): ReturnType<typeof render> {
  return render(
    <ClaudeCliSessionPortalProvider>
      <MainPane />
    </ClaudeCliSessionPortalProvider>
  )
}

afterEach(() => {
  cleanup()
  useConnectionStore.setState(initialConnectionState, true)
  useFileViewerStore.setState(initialFileViewerState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useLayoutStore.setState(initialLayoutState, true)
  usePinnedStore.setState(initialPinnedState, true)
  useProjectStore.setState(initialProjectState, true)
  useSessionStore.setState(initialSessionState, true)
  useSettingsStore.setState(initialSettingsState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
})

describe('MainPane terminal visibility', () => {
  it('shows a stateful terminal session when it is the active main content', () => {
    setupMainPaneState()

    renderMainPane()

    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('true')
    expect(terminal.parentElement?.classList.contains('flex-1')).toBe(true)
  })

  it.each([
    ['board view', () => useKanbanStore.setState({ isBoardViewActive: true })],
    ['pinned board', () => useKanbanStore.setState({ isPinnedBoardActive: true })],
    [
      'board assistant',
      () => useSessionStore.setState({ activeBoardAssistantProjectId: 'project-1' })
    ]
  ])('keeps the stateful terminal mounted but hidden during %s', (_label, activateView) => {
    setupMainPaneState()
    activateView()

    renderMainPane()

    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('false')
    expect(terminal.closest('.hidden')).not.toBeNull()
  })

  it('keeps the active terminal laid out while a ghostty-suppressing overlay is open', () => {
    // Popovers/dropdowns push ghostty suppression to hide the native NSView.
    // The HTML container must stay visible: overlays anchored inside the
    // session view (e.g. the handoff picker) lose their anchor geometry and
    // teleport to the viewport corner if the container collapses.
    setupMainPaneState()
    useLayoutStore.setState({ ghosttyOverlaySuppressed: true })

    renderMainPane()

    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('true')
    expect(terminal.closest('.hidden')).toBeNull()
  })

  it('keeps a plain terminal session mounted but hidden during board view', () => {
    setupMainPaneState(makeSession({ id: 'terminal-1', agent_sdk: 'terminal' }))
    useKanbanStore.setState({ isBoardViewActive: true })

    renderMainPane()

    const terminal = screen.getByTestId('terminal-view-terminal-1')
    expect(terminal.getAttribute('data-visible')).toBe('false')
    expect(terminal.parentElement?.classList.contains('hidden')).toBe(true)
  })
})

// Mounting a stateful terminal view spawns its agent process, so sessions that
// merely have a tab must NOT mount until an activation signal selects them.
describe('MainPane late session record', () => {
  // "Go to session" from a board can activate a session of a worktree whose
  // sessions have not been loaded yet: the active id is set first, the record
  // arrives when SessionTabs finishes loadSessions. The terminal must become
  // visible then — not stay hidden until the user switches tabs.
  it('shows the active terminal session once its record loads', () => {
    setupMainPaneState()
    useSessionStore.setState({ sessionsByWorktree: new Map([['worktree-1', []]]) })

    renderMainPane()

    act(() => {
      useSessionStore.setState({ sessionsByWorktree: new Map([['worktree-1', [makeSession()]]]) })
    })

    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('true')
    expect(terminal.parentElement?.classList.contains('flex-1')).toBe(true)
    expect(terminal.closest('.hidden')).toBeNull()
  })

  it('shows the active terminal session when it is navigated to in one batch with the pinned board closing', () => {
    setupMainPaneState()
    useKanbanStore.setState({ isPinnedBoardActive: true })
    useSessionStore.setState({
      activeSessionId: null,
      sessionsByWorktree: new Map([['worktree-1', []]])
    })

    renderMainPane()
    expect(screen.getByTestId('kanban-board')).not.toBeNull()

    // leaveBoardViews + setActiveWorktree/setActiveSession, as every go-to-session does
    act(() => {
      useKanbanStore.getState().closePinnedBoard()
      useSessionStore.setState({ activeSessionId: 'session-1' })
    })
    // The worktree's sessions arrive afterwards
    act(() => {
      useSessionStore.setState({ sessionsByWorktree: new Map([['worktree-1', [makeSession()]]]) })
    })

    expect(screen.queryByTestId('kanban-board')).toBeNull()
    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('true')
    expect(terminal.closest('.hidden')).toBeNull()
  })
})

describe('MainPane terminal activation gating', () => {
  const second = makeSession({ id: 'session-2', name: 'Claude CLI 2' })

  function setupTwoSessions(): void {
    setupMainPaneState()
    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [makeSession(), second]]])
    })
  }

  it('does not mount an in-scope terminal session that is not activated', () => {
    setupTwoSessions()

    renderMainPane()

    expect(screen.getByTestId('session-view-session-1')).toBeTruthy()
    expect(screen.queryByTestId('session-view-session-2')).toBeNull()
  })

  it('mounts a session once it becomes the active tab and keeps it mounted after switching away', () => {
    setupTwoSessions()

    renderMainPane()
    expect(screen.queryByTestId('session-view-session-2')).toBeNull()

    act(() => {
      useSessionStore.setState({ activeSessionId: 'session-2' })
    })
    expect(screen.getByTestId('session-view-session-2').getAttribute('data-visible')).toBe('true')

    // Switching back must keep session-2 mounted (latched) but hidden
    act(() => {
      useSessionStore.setState({ activeSessionId: 'session-1' })
    })
    const latched = screen.getByTestId('session-view-session-2')
    expect(latched.getAttribute('data-visible')).toBe('false')
    expect(latched.closest('.hidden')).not.toBeNull()
  })

  it('mounts a non-active session with a pending mount request (ticket modal)', () => {
    setupTwoSessions()
    useSessionStore.setState({ sessionMountRequests: new Map([['session-2', 1]]) })

    renderMainPane()

    expect(screen.getByTestId('session-view-session-2')).toBeTruthy()
  })

  it('mounts a non-active session with a queued pending message', () => {
    setupTwoSessions()
    useSessionStore.setState({ pendingMessages: new Map([['session-2', 'do the thing']]) })

    renderMainPane()

    expect(screen.getByTestId('session-view-session-2')).toBeTruthy()
  })

  it('mounts a non-active pinned session', () => {
    setupTwoSessions()
    useSessionStore.setState({ activePinnedSessionId: 'session-2' })

    renderMainPane()

    expect(screen.getByTestId('session-view-session-2')).toBeTruthy()
  })

  it('mounts an inline connection session even when its connection is not selected', () => {
    setupMainPaneState()
    const connSession = makeSession({
      id: 'conn-session-1',
      worktree_id: null,
      connection_id: 'connection-1'
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['connection-1', [connSession]]]),
      inlineConnectionSessionId: 'conn-session-1'
    })

    renderMainPane()

    expect(screen.getByTestId('session-view-conn-session-1')).toBeTruthy()
  })

  it('renders a member branch diff while a connection (no worktree) is selected', async () => {
    setupMainPaneState()
    useWorktreeStore.setState({ selectedWorktreeId: null })
    useConnectionStore.setState({ selectedConnectionId: 'connection-1', loaded: true })
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/repo/member-a',
      filePath: 'src/index.ts',
      fileName: 'index.ts',
      staged: false,
      isUntracked: false,
      compareBranch: 'main'
    })

    renderMainPane()

    const diff = await screen.findByTestId('monaco-diff-view')
    expect(diff.getAttribute('data-worktree')).toBe('/repo/member-a')
    expect(diff.getAttribute('data-branch')).toBe('main')
    expect(useFileViewerStore.getState().activeFilePath).toBe(
      'diff:/repo/member-a:src/index.ts:branch:main'
    )
  })

  it('unmounts a latched session when its tab is closed', () => {
    setupTwoSessions()

    renderMainPane()
    act(() => {
      useSessionStore.setState({ activeSessionId: 'session-2' })
    })
    expect(screen.getByTestId('session-view-session-2')).toBeTruthy()

    act(() => {
      useSessionStore.setState({
        activeSessionId: 'session-1',
        closedTerminalSessionIds: new Set(['session-2'])
      })
    })
    expect(screen.queryByTestId('session-view-session-2')).toBeNull()
  })
})

// A shell-command session is stored as the terminal SDK. Mounting the plain terminal
// view for it would spawn a second, interactive shell under the same id.
describe('MainPane shell-command sessions', () => {
  const shellSession = makeSession({
    id: 'shell-1',
    name: 'Build',
    agent_sdk: 'terminal',
    session_type: 'shell-command',
    model_provider_id: null,
    model_id: null
  })

  it('renders an active shell-command session through the portal, not the terminal view', () => {
    setupMainPaneState(shellSession)

    renderMainPane()

    const view = screen.getByTestId('session-view-shell-1')
    expect(view.getAttribute('data-visible')).toBe('true')
    expect(screen.queryByTestId('terminal-view-shell-1')).toBeNull()
  })

  it('still renders a plain terminal session with the terminal view', () => {
    setupMainPaneState(makeSession({ id: 'terminal-1', agent_sdk: 'terminal' }))

    renderMainPane()

    expect(screen.getByTestId('terminal-view-terminal-1').getAttribute('data-visible')).toBe('true')
    expect(screen.queryByTestId('session-view-terminal-1')).toBeNull()
  })

  it('keeps a shell-command session mounted but hidden during board view', () => {
    setupMainPaneState(shellSession)
    useKanbanStore.setState({ isBoardViewActive: true })

    renderMainPane()

    const view = screen.getByTestId('session-view-shell-1')
    expect(view.getAttribute('data-visible')).toBe('false')
    expect(view.closest('.hidden')).not.toBeNull()
  })

  it('admits a non-active shell-command session with a mount request (ticket modal)', () => {
    setupMainPaneState()
    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [makeSession(), shellSession]]])
    })

    renderMainPane()
    expect(screen.queryByTestId('session-view-shell-1')).toBeNull()

    act(() => {
      useSessionStore.setState({ sessionMountRequests: new Map([['shell-1', 1]]) })
    })

    expect(screen.getByTestId('session-view-shell-1').getAttribute('data-visible')).toBe('false')
    expect(screen.queryByTestId('terminal-view-shell-1')).toBeNull()
  })

  it('admits a mount request for a shell-command session of another worktree', () => {
    setupMainPaneState()
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['worktree-1', [makeSession()]],
        ['worktree-2', [{ ...shellSession, worktree_id: 'worktree-2' }]]
      ]),
      sessionMountRequests: new Map([['shell-1', 1]])
    })

    renderMainPane()

    expect(screen.getByTestId('session-view-shell-1')).toBeTruthy()
    expect(screen.queryByTestId('terminal-view-shell-1')).toBeNull()
  })

  it('does not admit a mount request for a plain terminal session', () => {
    setupMainPaneState()
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['worktree-1', [makeSession()]],
        ['worktree-2', [makeSession({ id: 'terminal-1', agent_sdk: 'terminal' })]]
      ]),
      sessionMountRequests: new Map([['terminal-1', 1]])
    })

    renderMainPane()

    expect(screen.queryByTestId('terminal-view-terminal-1')).toBeNull()
    expect(screen.queryByTestId('session-view-terminal-1')).toBeNull()
  })

  it('keeps avoiding the terminal view after the session leaves the store', () => {
    setupMainPaneState(shellSession)

    renderMainPane()
    expect(screen.getByTestId('session-view-shell-1')).toBeTruthy()

    // Transient session-map churn: the session is no longer resolvable, so the
    // cached mount kind (not the raw 'terminal' SDK) decides what stays mounted.
    act(() => {
      useSessionStore.setState({
        activeSessionId: null,
        sessionsByWorktree: new Map([['worktree-1', []]])
      })
    })

    expect(screen.getByTestId('session-view-shell-1').closest('.hidden')).not.toBeNull()
    expect(screen.queryByTestId('terminal-view-shell-1')).toBeNull()
  })
})
