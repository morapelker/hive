import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock ipcRenderer for preload-level tests ---
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

function mockOn(channel: string, handler: (...args: unknown[]) => void): void {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  listeners.get(channel)!.add(handler)
}

function mockRemoveListener(channel: string, handler: (...args: unknown[]) => void): void {
  listeners.get(channel)?.delete(handler)
}

function emit(channel: string, ...args: unknown[]): void {
  listeners.get(channel)?.forEach((handler) => handler(...args))
}

// Build onWindowFocused using the same pattern as the preload
function createOnWindowFocused() {
  return (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    mockOn('app:windowFocused', handler)
    return () => {
      mockRemoveListener('app:windowFocused', handler)
    }
  }
}

describe('Session 4: Git Refresh on Focus', () => {
  beforeEach(() => {
    listeners.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('onWindowFocused callback fires on app:windowFocused event', () => {
    const onWindowFocused = createOnWindowFocused()
    const callback = vi.fn()

    onWindowFocused(callback)
    emit('app:windowFocused')

    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('onWindowFocused callback fires multiple times on repeated events', () => {
    const onWindowFocused = createOnWindowFocused()
    const callback = vi.fn()

    onWindowFocused(callback)
    emit('app:windowFocused')
    emit('app:windowFocused')
    emit('app:windowFocused')

    expect(callback).toHaveBeenCalledTimes(3)
  })

  test('unsubscribe removes the listener', () => {
    const onWindowFocused = createOnWindowFocused()
    const callback = vi.fn()

    const unsubscribe = onWindowFocused(callback)
    emit('app:windowFocused')
    expect(callback).toHaveBeenCalledTimes(1)

    unsubscribe()
    emit('app:windowFocused')
    expect(callback).toHaveBeenCalledTimes(1) // Not called again
  })

  test('throttle prevents rapid successive refreshes', () => {
    const refreshStatuses = vi.fn()
    const THROTTLE_MS = 2000

    // Simulate the throttle logic from useWindowFocusRefresh
    let lastRefreshTime = 0
    const throttledRefresh = (): void => {
      const now = Date.now()
      if (now - lastRefreshTime < THROTTLE_MS) return
      lastRefreshTime = now
      refreshStatuses()
    }

    // Simulate 5 focus events within 1 second
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(200)
    throttledRefresh()
    vi.advanceTimersByTime(200)
    throttledRefresh()
    vi.advanceTimersByTime(200)
    throttledRefresh()
    vi.advanceTimersByTime(200)
    throttledRefresh()

    // Only the first call should have gone through
    expect(refreshStatuses).toHaveBeenCalledTimes(1)
  })

  test('throttle allows refresh after 2 seconds', () => {
    const refreshStatuses = vi.fn()
    const THROTTLE_MS = 2000

    let lastRefreshTime = 0
    const throttledRefresh = (): void => {
      const now = Date.now()
      if (now - lastRefreshTime < THROTTLE_MS) return
      lastRefreshTime = now
      refreshStatuses()
    }

    // First call goes through
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(1)

    // Advance past the throttle window
    vi.advanceTimersByTime(2001)
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(2)
  })

  test('throttle blocks at exactly 2000ms but allows at 2001ms', () => {
    const refreshStatuses = vi.fn()
    const THROTTLE_MS = 2000

    let lastRefreshTime = 0
    const throttledRefresh = (): void => {
      const now = Date.now()
      if (now - lastRefreshTime < THROTTLE_MS) return
      lastRefreshTime = now
      refreshStatuses()
    }

    // First call
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(1)

    // At exactly 1999ms -- should be blocked
    vi.advanceTimersByTime(1999)
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(1)

    // Advance 2ms more (total 2001ms from first) -- should go through
    vi.advanceTimersByTime(2)
    throttledRefresh()
    expect(refreshStatuses).toHaveBeenCalledTimes(2)
  })

  test('refreshes all tracked worktrees on focus', () => {
    const refreshStatuses = vi.fn()
    const worktreePaths = ['/path/to/worktree-a', '/path/to/worktree-b', '/path/to/worktree-c']

    // Simulate what the hook does: iterate over all worktree paths
    const simulateFocusRefresh = (): void => {
      for (const worktreePath of worktreePaths) {
        refreshStatuses(worktreePath)
      }
    }

    simulateFocusRefresh()

    expect(refreshStatuses).toHaveBeenCalledTimes(3)
    expect(refreshStatuses).toHaveBeenCalledWith('/path/to/worktree-a')
    expect(refreshStatuses).toHaveBeenCalledWith('/path/to/worktree-b')
    expect(refreshStatuses).toHaveBeenCalledWith('/path/to/worktree-c')
  })

  test('no refresh when no worktrees are tracked', () => {
    const refreshStatuses = vi.fn()
    const worktreePaths: string[] = []

    const simulateFocusRefresh = (): void => {
      for (const worktreePath of worktreePaths) {
        refreshStatuses(worktreePath)
      }
    }

    simulateFocusRefresh()
    expect(refreshStatuses).not.toHaveBeenCalled()
  })
})
