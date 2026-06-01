import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCliSessionView } from './ClaudeCliSessionView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: () => <div data-testid="terminal-view" />
}))

vi.mock('@/contexts/ClaudeCliSessionPortalContext', () => ({
  useClaudeCliSessionPortal: () => ({
    getTarget: () => null,
    revision: 0
  })
}))

vi.mock('./ModeToggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle" />
}))

vi.mock('./SuperToggle', () => ({
  SuperToggle: () => <div data-testid="super-toggle" />
}))

const initialSessionState = useSessionStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialStatusState = useWorktreeStatusStore.getState()
let sessionMessageList: ReturnType<typeof vi.fn>
let sessionActivityList: ReturnType<typeof vi.fn>

const session = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Claude CLI',
  status: 'active' as const,
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'claude-code-cli' as const,
  mode: 'build' as const,
  session_type: 'default' as const,
  model_provider_id: 'anthropic',
  model_id: 'sonnet',
  model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null
}

describe('ClaudeCliSessionView blank provider switch', () => {
  beforeEach(() => {
    useSessionStore.setState(initialSessionState, true)
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)

    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [session]]]),
      sessionsByConnection: new Map(),
      modeBySession: new Map([['session-1', 'build']]),
      pendingMessages: new Map(),
      pendingFollowUpMessages: new Map(),
      pendingPlans: new Map()
    })
    useSettingsStore.setState({
      availableAgentSdks: { opencode: true, claude: true, codex: true }
    })
    sessionMessageList = vi.fn(async () => [])
    sessionActivityList = vi.fn(async () => [])
    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        sessionMessage: {
          list: sessionMessageList
        },
        sessionActivity: {
          list: sessionActivityList
        }
      }
    })
    Object.defineProperty(window, 'terminalOps', {
      writable: true,
      configurable: true,
      value: {
        onClaudeSessionId: vi.fn(() => vi.fn())
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the provider selector enabled for an idle pty_start status', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-1': {
          status: 'completed',
          reason: 'pty_start',
          timestamp: Date.now()
        }
      }
    })

    render(<ClaudeCliSessionView sessionId="session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('session-provider-selector')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('session-provider-label')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-selector')).not.toBeInTheDocument()
  })

  it('returns to static provider text when durable history appears after mount', async () => {
    render(<ClaudeCliSessionView sessionId="session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('session-provider-selector')).toBeInTheDocument()
    })

    sessionMessageList.mockResolvedValue([{ id: 'message-1' }])

    await waitFor(
      () => {
        expect(screen.getByTestId('session-provider-label')).toBeInTheDocument()
      },
      { timeout: 2500 }
    )
    expect(screen.queryByTestId('session-provider-selector')).not.toBeInTheDocument()
  })
})
