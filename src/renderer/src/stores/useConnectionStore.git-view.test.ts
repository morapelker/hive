import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      isPinnedBoardActive: false,
      togglePinnedBoard: vi.fn(),
      closePinnedBoard: vi.fn()
    }))
  }
}))

import { useConnectionStore } from './useConnectionStore'
import { clearConnectionSelection } from './store-coordination'

describe('useConnectionStore connection git view', () => {
  afterEach(() => {
    useConnectionStore.setState({ selectedConnectionId: null, connectionGitView: 'connection' })
  })

  it('defaults to the connection view', () => {
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('selects a connection with the base git view on request', () => {
    useConnectionStore.getState().selectConnection('conn-1', { gitView: 'base' })
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('base')
  })

  it('re-selecting the same connection (sidebar tap) returns to the connection view', () => {
    useConnectionStore.getState().selectConnection('conn-1', { gitView: 'base' })
    useConnectionStore.getState().selectConnection('conn-1')
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('selecting another connection drops the base view', () => {
    useConnectionStore.getState().selectConnection('conn-1', { gitView: 'base' })
    useConnectionStore.getState().selectConnection('conn-2')
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('clearing the selection (worktree selected elsewhere) resets the view', () => {
    useConnectionStore.getState().selectConnection('conn-1', { gitView: 'base' })
    clearConnectionSelection()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('does not keep the base view when deselecting', () => {
    useConnectionStore.getState().selectConnection('conn-1', { gitView: 'base' })
    useConnectionStore.getState().selectConnection(null, { gitView: 'base' })
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })
})
