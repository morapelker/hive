// MainPane with an open data project (database client): its branch wins over every board
// branch (Pinned Board in front, board view, sticky Board tab), hides SessionTabs and the
// always-mounted terminals, and gives the pane back when the Pinned Board is revealed or a
// worktree is selected.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainPane } from './MainPane'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore, BOARD_TAB_ID } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'
import { sampleGitProject } from '@/components/data-projects/data-project.sample'

vi.mock('@/components/data-projects/DataProjectView', () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="data-project-view" data-project-id={projectId} />
  )
}))
vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: { touch: vi.fn(async () => undefined), onStatus: vi.fn(() => () => {}) }
}))
vi.mock('@/components/sessions', () => ({
  SessionTabs: () => <div data-testid="session-tabs" />,
  SessionView: ({ sessionId, isVisible }: { sessionId: string; isVisible?: boolean }) => (
    <div data-testid={`session-view-${sessionId}`} data-visible={String(isVisible)} />
  )
}))
vi.mock('@/components/sessions/SessionTerminalView', () => ({
  SessionTerminalView: () => null
}))
vi.mock('@/components/kanban/KanbanBoard', () => ({
  KanbanBoard: ({ isPinnedMode }: { isPinnedMode?: boolean }) => (
    <div data-testid="kanban-board" data-pinned={String(!!isPinnedMode)} />
  )
}))
vi.mock('@/components/kanban/KanbanIcon', () => ({ KanbanIcon: () => null }))
vi.mock('@/components/kanban/BoardAssistantView', () => ({ BoardAssistantView: () => null }))
vi.mock('@/components/pr/PRNotificationStack', () => ({ PRNotificationStack: () => null }))
vi.mock('./MainPaneTerminalPanel', () => ({ MainPaneTerminalPanel: () => null }))
vi.mock('@/components/agent/TedoooAgentPanel', () => ({ TedoooAgentPanel: () => null }))

const initial = {
  connection: useConnectionStore.getState(),
  data: useDataProjectStore.getState(),
  fileViewer: useFileViewerStore.getState(),
  kanban: useKanbanStore.getState(),
  pinned: usePinnedStore.getState(),
  project: useProjectStore.getState(),
  session: useSessionStore.getState(),
  settings: useSettingsStore.getState(),
  worktree: useWorktreeStore.getState()
}

const session = {
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
  completed_at: null
}

beforeEach(() => {
  useConnectionStore.setState({ selectedConnectionId: null, loaded: true })
  useFileViewerStore.setState({
    activeFilePath: null,
    activeDiff: null,
    contextEditorWorktreeId: null
  })
  useKanbanStore.setState({
    isBoardViewActive: false,
    isPinnedBoardActive: false,
    isPinnedBoardBehindSession: false
  })
  usePinnedStore.setState({ loaded: true })
  useProjectStore.setState({
    selectedProjectId: 'project-1',
    projects: [sampleGitProject('project-1', 0)] as never
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
  } as never)
  useSettingsStore.setState({ boardMode: 'toggle', terminalPosition: 'sidebar' })
  useWorktreeStore.setState({ selectedWorktreeId: 'worktree-1' })
})

afterEach(() => {
  cleanup()
  useConnectionStore.setState(initial.connection, true)
  useDataProjectStore.setState(initial.data, true)
  useFileViewerStore.setState(initial.fileViewer, true)
  useKanbanStore.setState(initial.kanban, true)
  usePinnedStore.setState(initial.pinned, true)
  useProjectStore.setState(initial.project, true)
  useSessionStore.setState(initial.session, true)
  useSettingsStore.setState(initial.settings, true)
  useWorktreeStore.setState(initial.worktree, true)
})

const renderMainPane = (): void => {
  render(
    <ClaudeCliSessionPortalProvider>
      <MainPane />
    </ClaudeCliSessionPortalProvider>
  )
}

describe('MainPane with a data project', () => {
  it('shows the data project in front of an active Pinned Board', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })
    renderMainPane()
    expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-pinned', 'true')

    act(() => useDataProjectStore.getState().select('dp-1'))

    expect(await screen.findByTestId('data-project-view')).toHaveAttribute(
      'data-project-id',
      'dp-1'
    )
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-tabs')).not.toBeInTheDocument()
    // Pinned mode stays on, behind the database client.
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
  })

  it('wins over the board view and the sticky Board tab', async () => {
    useKanbanStore.setState({ isBoardViewActive: true })
    useSettingsStore.setState({ boardMode: 'sticky-tab' })
    useSessionStore.setState({ activeSessionId: BOARD_TAB_ID })
    useDataProjectStore.setState({ selectedDataProjectId: 'dp-1' })
    renderMainPane()

    expect(await screen.findByTestId('data-project-view')).toBeInTheDocument()
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument()
  })

  it('hides SessionTabs and the always-mounted terminal session', async () => {
    renderMainPane()
    expect(screen.getByTestId('session-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('session-view-session-1')).toHaveAttribute('data-visible', 'true')

    act(() => useDataProjectStore.getState().select('dp-1'))

    await screen.findByTestId('data-project-view')
    expect(screen.queryByTestId('session-tabs')).not.toBeInTheDocument()
    const terminal = screen.getByTestId('session-view-session-1')
    expect(terminal).toHaveAttribute('data-visible', 'false')
    expect(terminal.closest('.hidden')).not.toBeNull()
  })

  it('gives the pane back to the Pinned Board when it is toggled to the front', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })
    renderMainPane()
    act(() => useDataProjectStore.getState().select('dp-1'))
    await screen.findByTestId('data-project-view')

    act(() => useKanbanStore.getState().togglePinnedBoard())

    await waitFor(() =>
      expect(screen.getByTestId('kanban-board')).toHaveAttribute('data-pinned', 'true')
    )
    expect(screen.queryByTestId('data-project-view')).not.toBeInTheDocument()
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('gives the pane back when a worktree is selected', async () => {
    renderMainPane()
    act(() => useDataProjectStore.getState().select('dp-1'))
    await screen.findByTestId('data-project-view')

    act(() => useWorktreeStore.getState().selectWorktree('worktree-1'))

    await waitFor(() => expect(screen.queryByTestId('data-project-view')).not.toBeInTheDocument())
    expect(screen.getByTestId('session-view-session-1')).toHaveAttribute('data-visible', 'true')
  })
})
