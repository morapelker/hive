import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketModal } from './KanbanTicketModal'
import { ClaudeCliSessionView } from '../sessions/ClaudeCliSessionView'
import {
  ClaudeCliSessionPortalProvider,
  useClaudeCliSessionPortal
} from '@/contexts/ClaudeCliSessionPortalContext'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session, Worktree } from '../../../../main/db/types'

vi.mock('../sessions/HandoffSplitButton', () => ({
  HandoffSplitButton: ({
    onHandoff,
    testIdPrefix = 'plan-ready',
    disabled = false
  }: {
    onHandoff: (override: {
      agentSdk: 'claude-code-cli' | 'codex'
      model?: { providerID: string; modelID: string }
      goalMode?: boolean
    }) => void
    testIdPrefix?: string
    disabled?: boolean
  }) => {
    let goalMode = false

    return (
      <button
        type="button"
        data-testid={`${testIdPrefix}-handoff-btn`}
        disabled={disabled}
        onContextMenu={(event) => {
          event.preventDefault()
          goalMode = true
        }}
        onClick={() =>
          onHandoff(
            goalMode
              ? {
                  agentSdk: 'codex',
                  model: { providerID: 'codex', modelID: 'gpt-5.5' },
                  goalMode: true
                }
              : { agentSdk: 'claude-code-cli' }
          )
        }
      >
        Handoff
      </button>
    )
  }
}))

vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: ({
    createTerminal
  }: {
    createTerminal?: () => Promise<unknown>
  }) => {
    useEffect(() => {
      void createTerminal?.()
    }, [createTerminal])
    return <div data-testid="mock-terminal-view" />
  }
}))

vi.mock('../sessions/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('./FollowupInput', () => ({
  FollowupInput: () => <div data-testid="followup-input" />
}))

vi.mock('./TicketRunButton', () => ({
  TicketRunButton: () => null
}))

vi.mock('@/hooks/useTicketRunScript', () => ({
  useTicketRunScript: () => ({ hasRunScript: false }),
  useTicketRunScriptHotkey: vi.fn()
}))

vi.mock('@/hooks/useDropZone', () => ({
  useDropZone: () => ({ isDragging: false })
}))

vi.mock('@/hooks/useConflictFixFlow', () => ({
  useConflictFixFlow: () => ({ startFixFlow: vi.fn(), openAttachedSession: vi.fn() })
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const now = '2026-01-01T00:00:00.000Z'

const terminalApiMocks = vi.hoisted(() => ({
  createClaudeCli: vi.fn().mockResolvedValue({ success: true, value: { success: true } }),
  onClaudeSessionId: vi.fn().mockReturnValue(() => {})
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

const opencodeApiMocks = vi.hoisted(() => ({
  abort: vi.fn().mockResolvedValue({ success: true, value: { success: true } }),
  commands: vi.fn().mockResolvedValue({ success: true, value: { success: true, commands: [] } }),
  listModels: vi.fn().mockResolvedValue({ success: true, value: { success: true, providers: [] } })
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: opencodeApiMocks
}))

const dbApiMocks = vi.hoisted(() => ({
  session: {
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ success: true, value: undefined })
  },
  worktree: {
    get: vi.fn().mockResolvedValue(null),
    getActiveByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ success: true, value: undefined })
  },
  setting: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

const gitApiMocks = vi.hoisted(() => ({
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] })
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const sourceSession: Session = {
  id: 'source-session',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Source Claude CLI',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'claude-code-cli',
  mode: 'plan',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'opus',
  model_variant: 'high',
  created_at: now,
  updated_at: now,
  completed_at: null,
  pinned_to_board: false
}

const handoffSession: Session = {
  ...sourceSession,
  id: 'handoff-session',
  name: 'Handoff Claude CLI',
  mode: 'build'
}

const ticket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Plan ticket',
  description: 'Ticket description',
  attachments: [],
  column: 'review',
  sort_order: 0,
  current_session_id: sourceSession.id,
  worktree_id: 'worktree-1',
  mode: 'plan',
  plan_ready: true,
  created_at: now,
  updated_at: now,
  archived_at: null,
  external_provider: null,
  external_id: null,
  external_url: null,
  github_pr_number: null,
  github_pr_url: null,
  mark: null,
  total_tokens: 0,
  pending_launch_config: null,
  goal_mode: false,
  goal_success_criteria: null,
  note: null
}

const worktree: Worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'Feature',
  branch_name: 'feature',
  path: '/repo/feature',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  created_at: now,
  last_accessed_at: now
}

function setupWindowApis(): void {
  terminalApiMocks.createClaudeCli.mockResolvedValue({ success: true, value: { success: true } })
  terminalApiMocks.onClaudeSessionId.mockReturnValue(() => {})

  opencodeApiMocks.abort.mockResolvedValue({ success: true, value: { success: true } })
  opencodeApiMocks.commands.mockResolvedValue({
    success: true,
    value: { success: true, commands: [] }
  })
  opencodeApiMocks.listModels.mockResolvedValue({
    success: true,
    value: { success: true, providers: [] }
  })
  dbApiMocks.session.get.mockResolvedValue(null)
  dbApiMocks.session.update.mockResolvedValue({ success: true, value: undefined })
  dbApiMocks.worktree.get.mockResolvedValue(worktree)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
  dbApiMocks.worktree.update.mockResolvedValue({ success: true, value: undefined })
  dbApiMocks.setting.get.mockResolvedValue(null)
  dbApiMocks.setting.set.mockResolvedValue(undefined)
  gitApiMocks.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
}

function setupStores(): {
  createSession: ReturnType<typeof vi.fn>
  setActiveSession: ReturnType<typeof vi.fn>
  relinkTicketsForHandoff: ReturnType<typeof vi.fn>
  setPendingMessage: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(
    async (
      _worktreeId: string,
      _projectId: string,
      agentSdk: Session['agent_sdk'] = 'claude-code-cli',
      mode?: Session['mode']
    ) => ({
      success: true,
      session: {
        ...handoffSession,
        agent_sdk: agentSdk,
        mode: mode ?? 'build',
        model_provider_id: agentSdk === 'codex' ? 'codex' : 'anthropic',
        model_id: agentSdk === 'codex' ? 'gpt-5.5' : 'opus'
      }
    })
  )
  const setActiveSession = vi.fn()
  const relinkTicketsForHandoff = vi.fn(async () => undefined)
  const setPendingMessage = vi.fn()

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    boardMode: 'toggle'
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
        created_at: now,
        last_accessed_at: now
      }
    ]
  })
  useWorktreeStore.setState({
    selectedWorktreeId: 'worktree-1',
    worktreesByProject: new Map([['project-1', [worktree]]]),
    selectWorktree: vi.fn(),
  })
  useKanbanStore.setState({
    selectedTicketId: ticket.id,
    isBoardViewActive: true,
    tickets: new Map([['project-1', [ticket]]]),
    updateTicket: vi.fn(async () => undefined),
    moveTicket: vi.fn(async () => undefined),
    relinkTicketsForHandoff
  })
  useSessionStore.setState({
    activeSessionId: sourceSession.id,
    activeWorktreeId: 'worktree-1',
    sessionsByWorktree: new Map([['worktree-1', [sourceSession]]]),
    sessionsByConnection: new Map(),
    pendingPlans: new Map([
      [
        sourceSession.id,
        { requestId: 'request-1', toolUseID: 'tool-1', planContent: 'Implement the plan.' }
      ]
    ]),
    createSession,
    setSessionMode: vi.fn(async () => undefined),
    setPendingMessage,
    dequeuePendingMessage: vi.fn(),
    clearPendingPlan: vi.fn(),
    requestSessionMount: vi.fn(),
    releaseSessionMount: vi.fn(),
    setActiveSession,
    setActiveWorktree: vi.fn()
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: { [sourceSession.id]: { status: 'plan_ready', timestamp: 0 } },
    clearSessionStatus: vi.fn()
  })

  return { createSession, setActiveSession, relinkTicketsForHandoff, setPendingMessage }
}

function RegisterClaudeCliPortalTarget({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { registerTarget } = useClaudeCliSessionPortal()
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    registerTarget(sessionId, ref.current)
    return () => registerTarget(sessionId, null)
  }, [registerTarget, sessionId])

  return <div ref={ref} data-testid="registered-claude-cli-target" />
}

describe('KanbanTicketModal handoff from Claude CLI plan review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupWindowApis()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  })

  it('starts the Claude CLI handoff without focusing the new session', async () => {
    const { createSession, setActiveSession } = setupStores()
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    await user.click(screen.getByTestId('plan-review-handoff-btn'))

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledWith('worktree-1', 'project-1', 'claude-code-cli', undefined, {
      autoFocus: false,
      modelOverride: undefined
    })
    await waitFor(() => expect(terminalApiMocks.createClaudeCli).toHaveBeenCalledTimes(1))
    expect(terminalApiMocks.createClaudeCli).toHaveBeenCalledWith('handoff-session', {
      pendingPrompt: expect.stringContaining('Implement the plan.')
    })
    expect(setActiveSession).not.toHaveBeenCalledWith('handoff-session')
    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
  })

  it('hides left-side followup and implement controls for Claude CLI plan review', async () => {
    setupStores()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    expect(screen.queryByTestId('followup-input')).toBeNull()
    expect(screen.queryByTestId('plan-review-implement-btn')).toBeNull()
    expect(screen.queryByTestId('plan-review-supercharge-btn')).toBeNull()
    expect(screen.queryByTestId('plan-review-supercharge-local-btn')).toBeNull()
    expect(screen.queryByTestId('plan-review-handoff-btn')).not.toBeNull()
  })

  it('keeps board focus when the portaled Claude CLI plan card handoff is clicked', async () => {
    const { createSession, setActiveSession } = setupStores()
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <RegisterClaudeCliPortalTarget sessionId={sourceSession.id} />
        <ClaudeCliSessionView sessionId={sourceSession.id} />
      </ClaudeCliSessionPortalProvider>
    )

    await user.click(screen.getByTestId('claude-cli-plan-ready-handoff-btn'))

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledWith('worktree-1', 'project-1', 'claude-code-cli', undefined, {
      autoFocus: false,
      modelOverride: undefined
    })
    await waitFor(() => expect(terminalApiMocks.createClaudeCli).toHaveBeenCalledWith(
      'handoff-session',
      { pendingPrompt: expect.stringContaining('Implement the plan.') }
    ))
    expect(setActiveSession).not.toHaveBeenCalledWith('handoff-session')
    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
    expect(useKanbanStore.getState().selectedTicketId).toBeNull()
  })

  it('marks the relinked ticket as goal mode when the Claude CLI plan card hands off to Codex goal mode', async () => {
    const { createSession, relinkTicketsForHandoff, setPendingMessage } = setupStores()
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <ClaudeCliSessionView sessionId={sourceSession.id} />
      </ClaudeCliSessionPortalProvider>
    )

    const handoffButton = screen.getByTestId('claude-cli-plan-ready-handoff-btn')
    fireEvent.contextMenu(handoffButton)
    await user.click(handoffButton)

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledWith('worktree-1', 'project-1', 'codex', undefined, {
      autoFocus: true,
      modelOverride: { providerID: 'codex', modelID: 'gpt-5.5' }
    })
    expect(setPendingMessage).toHaveBeenCalledWith(
      'handoff-session',
      '/goal Implement the following plan\nImplement the plan.'
    )
    expect(relinkTicketsForHandoff).toHaveBeenCalledWith(sourceSession.id, 'handoff-session', true)
  })

  it('auto-closes when an open Claude CLI question ticket returns to working', async () => {
    setupStores()
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...ticket, column: 'in_progress', plan_ready: false }]]])
    })
    useWorktreeStatusStore.getState().setSessionStatus(sourceSession.id, 'answering')

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    expect(screen.getByTestId('kanban-ticket-modal')).toBeInTheDocument()

    act(() => {
      useWorktreeStatusStore.getState().setSessionStatus(sourceSession.id, 'working')
    })

    await waitFor(() => {
      expect(useKanbanStore.getState().selectedTicketId).toBeNull()
    })
  })

  it('auto-closes a DB-loaded CLI question ticket even when working arrives before isClaudeCli resolves', async () => {
    setupStores()
    // Race setup: the session is NOT in the in-memory store, so `isClaudeCli`
    // only becomes known after the async DB fallback (findSessionById) resolves.
    // We hold that lookup open, flip answering→working while it's pending
    // (isClaudeCli still false), then resolve it — the modal must still close.
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map(),
      hydrateSession: vi.fn(),
      loadSessions: vi.fn(async () => undefined)
    })
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...ticket, column: 'in_progress', plan_ready: false }]]])
    })
    useWorktreeStatusStore.getState().setSessionStatus(sourceSession.id, 'answering')

    let resolveDbSession: (value: Session | null) => void = () => {}
    const dbSessionPromise = new Promise<Session | null>((resolve) => {
      resolveDbSession = resolve
    })
    const dbSessionGet = vi.fn().mockReturnValue(dbSessionPromise)
    dbApiMocks.session.get.mockImplementation(dbSessionGet)
    dbApiMocks.worktree.get.mockResolvedValue(worktree)

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    expect(screen.getByTestId('kanban-ticket-modal')).toBeInTheDocument()

    // Flip to working while the DB lookup (and thus isClaudeCli) is still pending.
    act(() => {
      useWorktreeStatusStore.getState().setSessionStatus(sourceSession.id, 'working')
    })

    // Still open: isClaudeCli hasn't resolved, so the close action is gated off —
    // but the latch must have remembered the earlier `answering`.
    expect(useKanbanStore.getState().selectedTicketId).toBe(ticket.id)

    // Resolve the DB lookup → isClaudeCli flips true → the latched answering→working
    // transition is honored on the re-run and the modal closes.
    await act(async () => {
      resolveDbSession(sourceSession)
      await dbSessionPromise
    })

    await waitFor(() => {
      expect(useKanbanStore.getState().selectedTicketId).toBeNull()
    })
  })
})
