import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SessionTerminalView } from '../../src/renderer/src/components/sessions/SessionTerminalView'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

const terminalViewMounts = new Map<string, number>()

vi.mock('@/components/terminal/TerminalView', async () => {
  const React = await import('react')

  function TerminalView({
    worktreeId,
    cwd
  }: {
    worktreeId: string
    cwd: string
  }): React.JSX.Element {
    React.useEffect(() => {
      terminalViewMounts.set(worktreeId, (terminalViewMounts.get(worktreeId) || 0) + 1)
    }, [worktreeId])

    return (
      <div data-testid={`terminal-view-${worktreeId}`} data-cwd={cwd}>
        terminal-view:{worktreeId}
      </div>
    )
  }

  return { TerminalView }
})

function makeTerminalSession(id: string) {
  return {
    id,
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: id,
    status: 'active' as const,
    opencode_session_id: null,
    agent_sdk: 'terminal' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null
  }
}

describe('SessionTerminalView persistence', () => {
  beforeEach(() => {
    terminalViewMounts.clear()

    act(() => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              {
                id: 'wt-1',
                project_id: 'proj-1',
                name: 'main',
                branch_name: 'main',
                path: '/tmp/project',
                status: 'active',
                is_default: true,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                created_at: '2026-01-01T00:00:00.000Z',
                last_accessed_at: '2026-01-01T00:00:00.000Z'
              }
            ]
          ]
        ])
      })

      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', [makeTerminalSession('term-1')]]]),
        sessionsByConnection: new Map()
      })
    })
  })

  test('keeps TerminalView mounted when session lookup is temporarily unavailable', () => {
    render(<SessionTerminalView sessionId="term-1" isVisible />)

    const terminalNode = screen.getByTestId('terminal-view-term-1')
    expect(terminalNode).toBeInTheDocument()
    expect(terminalNode).toHaveAttribute('data-cwd', '/tmp/project')
    expect(terminalViewMounts.get('term-1')).toBe(1)

    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', []]])
      })
    })

    expect(screen.getByTestId('terminal-view-term-1')).toBe(terminalNode)
    expect(screen.queryByText('Loading terminal...')).not.toBeInTheDocument()
    expect(terminalViewMounts.get('term-1')).toBe(1)
  })
})
