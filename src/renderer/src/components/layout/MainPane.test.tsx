import { cleanup, render, screen } from '@testing-library/react'
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

vi.mock('@/contexts/ClaudeCliSessionPortalContext', () => ({
  useClaudeCliSessionPortal: () => ({
    getTarget: () => null,
    revision: 0
  })
}))

vi.mock('./MainPaneTerminalPanel', () => ({
  MainPaneTerminalPanel: () => null
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
  session_type: 'default' | 'board-assistant'
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

    render(<MainPane />)

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

    render(<MainPane />)

    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal.getAttribute('data-visible')).toBe('false')
    expect(terminal.parentElement?.classList.contains('flex-1')).toBe(true)
  })

  it('keeps a plain terminal session mounted but hidden during board view', () => {
    setupMainPaneState(makeSession({ id: 'terminal-1', agent_sdk: 'terminal' }))
    useKanbanStore.setState({ isBoardViewActive: true })

    render(<MainPane />)

    const terminal = screen.getByTestId('terminal-view-terminal-1')
    expect(terminal.getAttribute('data-visible')).toBe('false')
    expect(terminal.parentElement?.classList.contains('hidden')).toBe(true)
  })
})
