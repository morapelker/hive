// When a session view starts over because the folder of its worktree became another folder,
// and, as important, when it does not. The stores are the real ones; the view is a stand-in
// keyed the way SessionView keys the real one, counting how often it mounts.
import { act, render, renderHook, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreePathEpoch } from './useWorktreePathEpoch'

type WorktreeRow = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  worktree_id: 'wt-1',
  project_id: 'p1',
  connection_id: null,
  name: 'Session',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'claude-code',
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

const setWorktrees = (...rows: WorktreeRow[]): void => {
  const byProject = new Map<string, WorktreeRow[]>()
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row])
  }
  act(() => {
    useWorktreeStore.setState({ worktreesByProject: byProject })
  })
}

const setSessions = (...sessions: Session[]): void => {
  const byWorktree = new Map<string, Session[]>()
  for (const entry of sessions) {
    const key = entry.worktree_id ?? 'none'
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), entry])
  }
  act(() => {
    useSessionStore.setState({ sessionsByWorktree: byWorktree, sessionsByConnection: new Map() })
  })
}

// Counts per test: how often the keyed view mounted, and how often the wrapper rendered.
let mounts = 0
let wrapperRenders = 0

function KeyedView(): React.JSX.Element {
  useEffect(() => {
    mounts += 1
  }, [])
  return <div data-testid="keyed-view" />
}

function Wrapper({ sessionId }: { sessionId: string }): React.JSX.Element {
  wrapperRenders += 1
  const epoch = useWorktreePathEpoch(sessionId)
  return (
    <div data-testid="wrapper" data-epoch={epoch}>
      <KeyedView key={epoch} />
    </div>
  )
}

const epochOnScreen = (): string | null => screen.getByTestId('wrapper').getAttribute('data-epoch')

describe('useWorktreePathEpoch', () => {
  beforeEach(() => {
    mounts = 0
    wrapperRenders = 0
    setSessions(session())
    setWorktrees()
  })

  it('starts at zero when the folder is known from the start', () => {
    setWorktrees(worktree('wt-1', '/old/app'))

    const { result } = renderHook(() => useWorktreePathEpoch('session-1'))

    expect(result.current).toBe(0)
  })

  it('goes up when the folder of the worktree becomes another folder, and the view starts over', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)
    const firstView = screen.getByTestId('keyed-view')
    expect(mounts).toBe(1)

    setWorktrees(worktree('wt-1', '/new/app'))

    expect(epochOnScreen()).toBe('1')
    expect(mounts).toBe(2)
    expect(screen.getByTestId('keyed-view')).not.toBe(firstView)
  })

  it('goes up once per move', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setWorktrees(worktree('wt-1', '/new/app'))
    setWorktrees(worktree('wt-1', '/newer/app'))

    expect(epochOnScreen()).toBe('2')
    expect(mounts).toBe(3)
  })

  it('does not go up when the rows of the worktree only show up after the view mounted', () => {
    render(<Wrapper sessionId="session-1" />)
    const firstView = screen.getByTestId('keyed-view')

    setWorktrees(worktree('wt-1', '/old/app'))

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
    expect(screen.getByTestId('keyed-view')).toBe(firstView)

    // From then on the folder is known, and a move counts.
    setWorktrees(worktree('wt-1', '/new/app'))

    expect(epochOnScreen()).toBe('1')
    expect(mounts).toBe(2)
  })

  it('does not go up when the session itself only shows up after the view mounted', () => {
    setSessions()
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setSessions(session())

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
  })

  it('does not go up, and does not even render, when another worktree changes', () => {
    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/old/other', 'p2'))
    render(<Wrapper sessionId="session-1" />)
    const firstView = screen.getByTestId('keyed-view')
    const rendersBefore = wrapperRenders

    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/new/other', 'p2'))
    setWorktrees(
      worktree('wt-1', '/old/app'),
      worktree('wt-2', '/new/other', 'p2'),
      worktree('wt-3', '/new/third', 'p3')
    )

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
    expect(screen.getByTestId('keyed-view')).toBe(firstView)
    expect(wrapperRenders).toBe(rendersBefore)
  })

  it('does not go up when the rows are reloaded with the same folder', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setWorktrees(worktree('wt-1', '/old/app'))
    setWorktrees({ ...worktree('wt-1', '/old/app'), branch_name: 'renamed' })

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
  })

  it('does not go up when the row goes away and comes back with the same folder', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setWorktrees()
    expect(epochOnScreen()).toBe('0')
    setWorktrees(worktree('wt-1', '/old/app'))

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
  })

  it('goes up when the row goes away and comes back in another folder', () => {
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setWorktrees()
    setWorktrees(worktree('wt-1', '/new/app'))

    expect(epochOnScreen()).toBe('1')
    expect(mounts).toBe(2)
  })

  it('stays at zero for a session without a worktree, whatever the worktrees do', () => {
    setSessions(session({ worktree_id: null, connection_id: 'conn-1' }))
    setWorktrees(worktree('wt-1', '/old/app'))
    render(<Wrapper sessionId="session-1" />)

    setWorktrees(worktree('wt-1', '/new/app'))

    expect(epochOnScreen()).toBe('0')
    expect(mounts).toBe(1)
  })

  it('keeps the views of two sessions apart: only the one whose worktree moved starts over', () => {
    setSessions(session(), session({ id: 'session-2', worktree_id: 'wt-2', project_id: 'p2' }))
    setWorktrees(worktree('wt-1', '/old/app'), worktree('wt-2', '/old/other', 'p2'))
    const first = renderHook(() => useWorktreePathEpoch('session-1'))
    const second = renderHook(() => useWorktreePathEpoch('session-2'))

    setWorktrees(worktree('wt-1', '/new/app'), worktree('wt-2', '/old/other', 'p2'))

    expect(first.result.current).toBe(1)
    expect(second.result.current).toBe(0)
  })
})
