import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

// Clearing a status must drop the key: a null placeholder per session ever
// seen makes every status event copy (and every subscriber diff) a record
// that only grows for the app's lifetime.

vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 's-unread' }, { id: 's-done' }, { id: 's-working' }])
  return {
    useSessionStore: {
      getState: () => ({ sessionsByWorktree, getSessionMode: () => 'build' })
    }
  }
})

// Partial mock: useWorktreeStore (pulled in transitively) needs the real
// registerWorktreeClear export at module load.
vi.mock('@/stores/store-coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/store-coordination')>()),
  notifyKanbanSessionSync: vi.fn()
}))

vi.mock('@/api/db-api', () => ({
  dbApi: { worktree: { update: vi.fn().mockResolvedValue(undefined) } }
}))

const getState = (): ReturnType<typeof useWorktreeStatusStore.getState> =>
  useWorktreeStatusStore.getState()

describe('useWorktreeStatusStore clears statuses by deleting keys', () => {
  beforeEach(() => {
    useWorktreeStatusStore.setState({ sessionStatuses: {}, reviewSessionByWorktree: {} })
  })

  test('setSessionStatus(null) removes the key instead of storing null', () => {
    getState().setSessionStatus('s-working', 'working')
    getState().setSessionStatus('s-working', null)
    expect('s-working' in getState().sessionStatuses).toBe(false)
  })

  test('clearSessionStatus removes the key instead of storing null', () => {
    getState().setSessionStatus('s-working', 'permission')
    getState().clearSessionStatus('s-working')
    expect('s-working' in getState().sessionStatuses).toBe(false)
  })

  test('clearWorktreeUnread removes unread/completed keys and keeps busy ones', () => {
    getState().setSessionStatus('s-unread', 'unread')
    getState().setSessionStatus('s-done', 'completed')
    getState().setSessionStatus('s-working', 'working')

    getState().clearWorktreeUnread('wt-1')

    expect(Object.keys(getState().sessionStatuses)).toEqual(['s-working'])
  })

  test('clearing an unknown session leaves the record identity untouched', () => {
    getState().setSessionStatus('s-working', 'working')
    const before = getState().sessionStatuses
    const listener = vi.fn()
    const unsubscribe = useWorktreeStatusStore.subscribe(listener)

    getState().setSessionStatus('never-seen', null)
    getState().clearSessionStatus('never-seen')
    getState().clearWorktreeUnread('wt-1')

    unsubscribe()
    expect(getState().sessionStatuses).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  test('a real update still produces a fresh record for subscribers', () => {
    getState().setSessionStatus('s-working', 'working')
    const before = getState().sessionStatuses
    getState().setSessionStatus('s-working', 'completed')
    expect(getState().sessionStatuses).not.toBe(before)
    expect(getState().sessionStatuses['s-working']?.status).toBe('completed')
  })

  test('clearing a review session on null still releases the worktree review', () => {
    getState().setSessionStatus('s-working', 'working')
    getState().setReviewSession('wt-1', 's-working')
    getState().setSessionStatus('s-working', null)
    expect(getState().isWorktreeBeingReviewed('wt-1')).toBe(false)
    expect('s-working' in getState().sessionStatuses).toBe(false)
  })
})
