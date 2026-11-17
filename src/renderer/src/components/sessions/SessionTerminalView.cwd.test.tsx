// The folder a terminal session's terminal starts in follows the worktree store: the rows can
// load after the view mounted, and the folder of a worktree changes when its project is moved
// to the dev folder. The terminal itself is a stand-in that shows the folder it was given.
import { act, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const terminalMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: function MockTerminalView({
    terminalId,
    cwd
  }: {
    terminalId: string
    cwd: string
  }): React.JSX.Element {
    useEffect(() => {
      terminalMounts.count += 1
    }, [])
    return <div data-testid={`terminal-view-${terminalId}`} data-cwd={cwd} />
  }
}))

import { useConnectionStore, type Connection } from '@/stores/useConnectionStore'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { SessionTerminalView } from './SessionTerminalView'

type WorktreeRow = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const terminalSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'term-1',
  worktree_id: 'wt-1',
  project_id: 'p1',
  connection_id: null,
  name: 'Terminal',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'terminal',
  mode: 'build',
  session_type: 'default',
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  ...overrides
})

const worktree = (id: string, path: string, projectId = 'p1'): WorktreeRow => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: 'main',
  path,
  status: 'active',
  is_default: true,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
})

const connection = (id: string, memberWorktreeIds: string[]): Connection => ({
  id,
  name: id,
  custom_name: null,
  status: 'active',
  path: `/Users/me/.hive/connections/${id}`,
  color: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  members: memberWorktreeIds.map((worktreeId, index) => ({
    id: `member-${index}`,
    connection_id: id,
    worktree_id: worktreeId,
    project_id: `p${index + 1}`,
    symlink_name: worktreeId,
    added_at: '2026-01-01T00:00:00.000Z',
    worktree_name: worktreeId,
    worktree_branch: 'main',
    worktree_path: `/stale/${worktreeId}`,
    project_name: `project ${index + 1}`
  }))
})

const setWorktrees = (...rows: WorktreeRow[]): void => {
  const byProject = new Map<string, WorktreeRow[]>()
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row])
  }
  act(() => {
    useWorktreeStore.setState({ worktreesByProject: byProject })
  })
}

const cwdOnScreen = (): string | null =>
  screen.getByTestId('terminal-view-term-1').getAttribute('data-cwd')

describe('SessionTerminalView working directory', () => {
  beforeEach(() => {
    terminalMounts.count = 0
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', [terminalSession()]]]),
        sessionsByConnection: new Map()
      })
      useConnectionStore.setState({ connections: [] })
    })
    setWorktrees()
  })

  it('starts in the folder of the session’s worktree', () => {
    setWorktrees(worktree('wt-1', '/old/app'))

    render(<SessionTerminalView sessionId="term-1" />)

    expect(cwdOnScreen()).toBe('/old/app')
  })

  it('follows the worktree when its project moves to another folder', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<SessionTerminalView sessionId="term-1" />)
    const terminal = screen.getByTestId('terminal-view-term-1')

    setWorktrees(worktree('wt-1', '/new/app'))

    expect(cwdOnScreen()).toBe('/new/app')
    // The same terminal view with a new folder: what it does with it is its own business.
    expect(screen.getByTestId('terminal-view-term-1')).toBe(terminal)
    expect(terminalMounts.count).toBe(1)
  })

  it('shows the terminal once the rows of its worktree load', () => {
    render(<SessionTerminalView sessionId="term-1" />)
    expect(screen.getByText('Loading terminal...')).toBeInTheDocument()

    setWorktrees(worktree('wt-1', '/old/app'))

    expect(cwdOnScreen()).toBe('/old/app')
  })

  it('keeps the folder it had when another worktree changes', () => {
    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/old/other', 'p2'))
    render(<SessionTerminalView sessionId="term-1" />)

    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/new/other', 'p2'))

    expect(cwdOnScreen()).toBe('/old/app')
    expect(terminalMounts.count).toBe(1)
  })

  it('keeps the last folder it knew when the row goes away', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<SessionTerminalView sessionId="term-1" />)

    setWorktrees()

    expect(cwdOnScreen()).toBe('/old/app')
    expect(terminalMounts.count).toBe(1)
  })

  it('follows the first member of the connection for a connection session', () => {
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map([
          ['conn-1', [terminalSession({ worktree_id: null, connection_id: 'conn-1' })]]
        ])
      })
      useConnectionStore.setState({ connections: [connection('conn-1', ['wt-1', 'wt-2'])] })
    })
    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/old/other', 'p2'))
    render(<SessionTerminalView sessionId="term-1" />)
    expect(cwdOnScreen()).toBe('/old/app')

    setWorktrees(worktree('wt-1', '/new/app'), worktree('wt-2', '/old/other', 'p2'))

    expect(cwdOnScreen()).toBe('/new/app')
  })

  it('finds the connection when it loads after the view mounted', () => {
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map([
          ['conn-1', [terminalSession({ worktree_id: null, connection_id: 'conn-1' })]]
        ])
      })
    })
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<SessionTerminalView sessionId="term-1" />)
    expect(screen.getByText('Loading terminal...')).toBeInTheDocument()

    act(() => {
      useConnectionStore.setState({ connections: [connection('conn-1', ['wt-1'])] })
    })

    expect(cwdOnScreen()).toBe('/old/app')
  })
})
