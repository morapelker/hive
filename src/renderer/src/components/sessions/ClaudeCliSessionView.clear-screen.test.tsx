// The view shared by Claude CLI and Codex CLI sessions tells its terminal what the clear-screen
// shortcut does. Claude Code runs in its fullscreen renderer in the app, so Cmd+K has it repaint
// the conversation; Codex keeps the plain clear it always had. The view is the real one with
// its terminal faked, and the session rows reach it through the store's own loads.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminal = vi.hoisted(() => ({
  props: [] as Array<{ terminalId: string; redrawOnClear?: boolean; shiftEnterAsNewline?: boolean }>
}))
vi.mock('@/components/terminal/TerminalView', async () => {
  const React = await import('react')
  return {
    TerminalView: React.forwardRef(function MockTerminalView(
      props: { terminalId: string; redrawOnClear?: boolean; shiftEnterAsNewline?: boolean },
      ref: unknown
    ) {
      React.useImperativeHandle(ref as React.Ref<{ focus: () => void }>, () => ({
        focus: () => {}
      }))
      terminal.props.push(props)
      return <div data-testid="mock-terminal-view" />
    })
  }
})

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    createClaudeCli: vi.fn(async () => ({ success: true, value: { success: true } })),
    onClaudeSessionId: vi.fn(() => () => {})
  }
}))

import { setRendererRpcClient } from '@/api/rpc-client'
import { ClaudeCliSessionView } from '@/components/sessions/ClaudeCliSessionView'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'
import { useSessionStore, type Session } from '@/stores/useSessionStore'

const NOW = '2026-11-15T08:00:00.000Z'
const PROJECT_ID = 'project-api'
const WORKTREE_ID = 'worktree-api'

function databaseRow(id: string, change: Record<string, unknown> = {}): Session {
  return {
    id,
    worktree_id: WORKTREE_ID,
    project_id: PROJECT_ID,
    connection_id: null,
    name: 'A session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    custom_provider_id: null,
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: null,
    remote_launch: null,
    cloud_run: null,
    shell_command: null,
    pinned_to_board: false,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...change
  } as Session
}

let rows: Session[]
const initialSessionState = useSessionStore.getState()

function mount(sessionId: string): void {
  render(
    <ClaudeCliSessionPortalProvider>
      <ClaudeCliSessionView sessionId={sessionId} />
    </ClaudeCliSessionPortalProvider>
  )
}

const lastTerminalProps = (): (typeof terminal.props)[number] => terminal.props.at(-1)!

beforeEach(() => {
  rows = []
  terminal.props.length = 0
  setRendererRpcClient({
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      const asked = (params ?? {}) as { id?: string; worktreeId?: string }
      switch (method) {
        case 'db.session.getActiveByWorktree':
          return rows.filter((row) => row.worktree_id === asked.worktreeId) as T
        case 'db.session.get':
          return (rows.find((row) => row.id === asked.id) ?? null) as T
        case 'db.session.getPinnedSessions':
          return [] as T
        default:
          return null as T
      }
    },
    subscribe: () => () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSessionStore.setState(initialSessionState, true)
})

async function loadRows(): Promise<void> {
  await act(async () => {
    await useSessionStore.getState().loadSessions(WORKTREE_ID, PROJECT_ID)
  })
}

describe('the clear-screen shortcut in a CLI session view', () => {
  it('has a Claude CLI session repaint its fullscreen screen', async () => {
    rows = [databaseRow('session-claude')]
    await loadRows()

    mount('session-claude')

    expect(lastTerminalProps().terminalId).toBe('session-claude')
    expect(lastTerminalProps().redrawOnClear).toBe(true)
  })

  it('has a Claude CLI session of a custom provider repaint too', async () => {
    rows = [databaseRow('session-custom', { custom_provider_id: 'provider-1' })]
    await loadRows()

    mount('session-custom')

    expect(lastTerminalProps().redrawOnClear).toBe(true)
  })

  it('leaves a Codex CLI session with the plain clear', async () => {
    rows = [databaseRow('session-codex', { agent_sdk: 'codex-cli', model_provider_id: 'codex' })]
    await loadRows()

    mount('session-codex')

    expect(lastTerminalProps().terminalId).toBe('session-codex')
    expect(lastTerminalProps().redrawOnClear).toBe(false)
    // What both CLIs share is unchanged.
    expect(lastTerminalProps().shiftEnterAsNewline).toBe(true)
  })

  it('turns it on once the session row arrives after the view mounted', async () => {
    rows = [databaseRow('session-late')]

    mount('session-late')
    expect(lastTerminalProps().redrawOnClear).toBe(false)

    await loadRows()
    expect(lastTerminalProps().redrawOnClear).toBe(true)
  })
})
