import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MainPane } from '../../src/renderer/src/components/layout/MainPane'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useConnectionStore } from '../../src/renderer/src/stores/useConnectionStore'
import { useFileViewerStore } from '../../src/renderer/src/stores/useFileViewerStore'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'

const terminalMounts = new Map<string, number>()

vi.mock('@/components/sessions', () => ({
  SessionTabs: () => <div data-testid="session-tabs" />,
  SessionView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`session-view-${sessionId}`}>{sessionId}</div>
  )
}))

vi.mock('@/components/sessions/SessionTerminalView', async () => {
  const React = await import('react')

  function SessionTerminalView({
    sessionId,
    isVisible
  }: {
    sessionId: string
    isVisible?: boolean
  }): React.JSX.Element {
    React.useEffect(() => {
      terminalMounts.set(sessionId, (terminalMounts.get(sessionId) || 0) + 1)
    }, [sessionId])

    return (
      <div
        data-testid={`session-terminal-${sessionId}`}
        data-visible={isVisible ? 'true' : 'false'}
      >
        terminal:{sessionId}
      </div>
    )
  }

  return { SessionTerminalView }
})

vi.mock('@/components/file-viewer', () => ({
  FileViewer: () => <div data-testid="file-viewer" />
}))

vi.mock('@/components/diff', () => ({
  InlineDiffViewer: () => <div data-testid="inline-diff-viewer" />
}))

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

describe('MainPane terminal persistence', () => {
  beforeEach(() => {
    terminalMounts.clear()

    act(() => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useConnectionStore.setState({ selectedConnectionId: null })
      useFileViewerStore.setState({ activeFilePath: null, activeDiff: null })
      useLayoutStore.setState({ ghosttyOverlaySuppressed: false } as never)

      useSessionStore.setState({
        activeSessionId: 'term-1',
        activeWorktreeId: 'wt-1',
        activeConnectionId: null,
        inlineConnectionSessionId: null,
        isLoading: false,
        closedTerminalSessionIds: new Set(),
        sessionsByWorktree: new Map([
          ['wt-1', [makeTerminalSession('term-1'), makeTerminalSession('term-2')]]
        ]),
        sessionsByConnection: new Map()
      })
    })
  })

  test('keeps each terminal instance mounted across tab switches and transient session reloads', () => {
    render(<MainPane />)

    const firstTerminalNode = screen.getByTestId('session-terminal-term-1')
    expect(terminalMounts.get('term-1')).toBe(1)
    expect(terminalMounts.get('term-2')).toBe(1)

    act(() => {
      useSessionStore.setState({ activeSessionId: 'term-2' })
    })

    // Simulate a transient sessions refresh where the scope map briefly empties,
    // then repopulates with the same terminal sessions.
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', []]])
      })
    })

    act(() => {
      useSessionStore.setState({
        activeSessionId: 'term-1',
        sessionsByWorktree: new Map([
          ['wt-1', [makeTerminalSession('term-1'), makeTerminalSession('term-2')]]
        ])
      })
    })

    const restoredTerminalNode = screen.getByTestId('session-terminal-term-1')

    expect(restoredTerminalNode).toBe(firstTerminalNode)
    expect(terminalMounts.get('term-1')).toBe(1)
    expect(terminalMounts.get('term-2')).toBe(1)
  })

  test('hides terminal surfaces when overlay suppression is enabled', () => {
    render(<MainPane />)

    expect(screen.getByTestId('session-terminal-term-1')).toHaveAttribute('data-visible', 'true')

    act(() => {
      useLayoutStore.setState({ ghosttyOverlaySuppressed: true } as never)
    })

    expect(screen.getByTestId('session-terminal-term-1')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByTestId('session-terminal-term-2')).toHaveAttribute('data-visible', 'false')
  })

  test('removes terminal from mounted list when session is closed via store signal', () => {
    render(<MainPane />)

    // Both terminals are mounted
    expect(screen.getByTestId('session-terminal-term-1')).toBeInTheDocument()
    expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()

    // Simulate closeSession: remove from sessions map AND signal via closedTerminalSessionIds
    act(() => {
      useSessionStore.setState({
        activeSessionId: 'term-2',
        closedTerminalSessionIds: new Set(['term-1']),
        sessionsByWorktree: new Map([['wt-1', [makeTerminalSession('term-2')]]])
      })
    })

    // term-1 should be unmounted, term-2 should remain
    expect(screen.queryByTestId('session-terminal-term-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()
  })
})
