import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('@/components/projects', () => ({
  ProjectList: () => <div data-testid="project-list" />,
  AddProjectButton: () => null,
  SortProjectsButton: () => null,
  RecentToggleButton: () => null,
  FilterChips: () => null
}))
vi.mock('@/components/projects/ProjectFilter', () => ({ ProjectFilter: () => null }))
vi.mock('@/components/connections', () => ({
  ConnectionList: () => null,
  ConnectionsButton: () => null
}))
vi.mock('@/components/spaces', () => ({ SpacesTabBar: () => null }))
vi.mock('./UsageIndicator', () => ({ UsageIndicator: () => null }))
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }))
vi.mock('./PinnedList', () => ({ PinnedList: () => null }))
vi.mock('./RecentList', () => ({ RecentList: () => null }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))

import { LeftSidebar } from './LeftSidebar'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'

function inProgressTicket(sessionId: string): KanbanTicket {
  return {
    id: `ticket-${sessionId}`,
    column: 'in_progress',
    current_session_id: sessionId,
    worktree_id: null,
    archived_at: null
  } as unknown as KanbanTicket
}

describe('LeftSidebar working-session indicator', () => {
  beforeEach(() => {
    cleanup()
    useLayoutStore.setState({ leftSidebarCollapsed: false })
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
    useKanbanStore.setState({ tickets: new Map() })
  })

  it('is hidden when no session is working', () => {
    render(<LeftSidebar />)
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.queryByTestId('working-session-indicator')).toBeNull()
  })

  it('shows a yellow spinner and the count of working/planning sessions', () => {
    render(<LeftSidebar />)
    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: {
          a: { status: 'working', timestamp: 1 },
          b: { status: 'planning', timestamp: 1 },
          c: { status: 'completed', timestamp: 1 },
          d: { status: 'permission', timestamp: 1 },
          e: null
        }
      })
    })
    const indicator = screen.getByTestId('working-session-indicator')
    expect(indicator.className).toContain('text-yellow-500')
    expect(indicator.querySelector('.agent-working-spinner')).not.toBeNull()
    expect(screen.getByTestId('working-session-count').textContent).toBe('2')

    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { a: { status: 'completed', timestamp: 2 } }
      })
    })
    expect(screen.queryByTestId('working-session-indicator')).toBeNull()
  })

  it('counts a session paused behind a pending monitor or wakeup', () => {
    render(<LeftSidebar />)
    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: {
          paused: { status: 'completed', timestamp: 1, completion: 'waiting' },
          finished: { status: 'completed', timestamp: 1, completion: 'completed' }
        }
      })
    })
    expect(screen.getByTestId('working-session-count').textContent).toBe('1')
  })

  it('counts every session linked from a ticket in the in-progress column', () => {
    render(<LeftSidebar />)
    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: {
          a: { status: 'working', timestamp: 1 },
          b: { status: 'completed', timestamp: 1 },
          c: { status: 'completed', timestamp: 1 }
        }
      })
      useKanbanStore.setState({
        tickets: new Map([
          ['proj-1', [inProgressTicket('a'), inProgressTicket('b')]],
          ['proj-2', [{ ...inProgressTicket('c'), column: 'review' }]]
        ])
      })
    })
    expect(screen.getByTestId('working-session-count').textContent).toBe('2')

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([
          ['proj-1', [inProgressTicket('a'), { ...inProgressTicket('b'), column: 'review' }]]
        ])
      })
    })
    expect(screen.getByTestId('working-session-count').textContent).toBe('1')
  })
})
