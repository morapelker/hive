import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSidebarHoverHighlight } from '../useSidebarHoverHighlight'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

type WorktreesByProject = ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']

describe('useSidebarHoverHighlight', () => {
  afterEach(() => {
    useKanbanStore.setState({
      hoveredSidebarTarget: null,
      isBoardViewActive: false,
      isPinnedBoardActive: false
    })
    useSessionStore.setState({ sessionsByConnection: new Map() })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    vi.restoreAllMocks()
  })

  it('sets the hovered target on enter and clears it on leave', () => {
    const { result } = renderHook(() => useSidebarHoverHighlight('worktree', 'wt1'))

    act(() => result.current.onMouseEnter())
    expect(useKanbanStore.getState().hoveredSidebarTarget).toEqual({
      kind: 'worktree',
      id: 'wt1',
      projectId: null
    })

    act(() => result.current.onMouseLeave())
    expect(useKanbanStore.getState().hoveredSidebarTarget).toBeNull()
  })

  it('resolves the worktree’s project so the highlight is worktree-agnostic', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([['p1', [{ id: 'wt1' }]]]) as unknown as WorktreesByProject
    })
    const { result } = renderHook(() => useSidebarHoverHighlight('worktree', 'wt1'))

    act(() => result.current.onMouseEnter())
    expect(useKanbanStore.getState().hoveredSidebarTarget).toEqual({
      kind: 'worktree',
      id: 'wt1',
      projectId: 'p1'
    })
  })

  it('does not clear a target set by a different card', () => {
    const a = renderHook(() => useSidebarHoverHighlight('project', 'p1'))
    const b = renderHook(() => useSidebarHoverHighlight('connection', 'c1'))

    act(() => a.result.current.onMouseEnter())
    act(() => b.result.current.onMouseEnter())
    // Leave events can arrive out of order; the stale card must not wipe the new target
    act(() => a.result.current.onMouseLeave())
    expect(useKanbanStore.getState().hoveredSidebarTarget).toEqual({ kind: 'connection', id: 'c1' })
  })

  it('clears its own target when the card unmounts mid-hover', () => {
    const { result, unmount } = renderHook(() => useSidebarHoverHighlight('worktree', 'wt1'))
    act(() => result.current.onMouseEnter())
    unmount()
    expect(useKanbanStore.getState().hoveredSidebarTarget).toBeNull()
  })

  it('keeps the same store reference when re-entering the same card', () => {
    const { result } = renderHook(() => useSidebarHoverHighlight('worktree', 'wt1'))
    act(() => result.current.onMouseEnter())
    const first = useKanbanStore.getState().hoveredSidebarTarget
    act(() => result.current.onMouseEnter())
    expect(useKanbanStore.getState().hoveredSidebarTarget).toBe(first)
  })

  it('background-loads connection sessions once while a board is open', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({ loadConnectionSessionsBackground: load })
    useKanbanStore.setState({ isPinnedBoardActive: true })
    const { result } = renderHook(() => useSidebarHoverHighlight('connection', 'c1'))

    act(() => result.current.onMouseEnter())
    expect(load).toHaveBeenCalledWith('c1')

    // Already loaded (key present, even if empty) → no refetch
    useSessionStore.setState({ sessionsByConnection: new Map([['c1', []]]) })
    act(() => result.current.onMouseLeave())
    act(() => result.current.onMouseEnter())
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not load connection sessions when no board is showing', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({ loadConnectionSessionsBackground: load })
    const { result } = renderHook(() => useSidebarHoverHighlight('connection', 'c1'))

    act(() => result.current.onMouseEnter())
    expect(load).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().hoveredSidebarTarget).toEqual({ kind: 'connection', id: 'c1' })
  })
})
