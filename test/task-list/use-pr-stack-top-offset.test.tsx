import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePRStackTopOffset } from '@/components/sessions/usePRStackTopOffset'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'

// -----------------------------------------------------------------------------
// Mock ResizeObserver — jsdom does not implement it natively. We also expose a
// trigger() so tests can simulate size-change notifications.
// -----------------------------------------------------------------------------

const observers: MockResizeObserver[] = []

class MockResizeObserver {
  observe = vi.fn((target: Element) => {
    this.target = target
  })
  disconnect = vi.fn()
  unobserve = vi.fn()
  private callback: ResizeObserverCallback
  private target: Element | null = null

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }

  trigger(): void {
    if (!this.target) return
    this.callback(
      [
        {
          target: this.target,
          contentRect: this.target.getBoundingClientRect()
        } as ResizeObserverEntry
      ],
      this as unknown as ResizeObserver
    )
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const originalPRState = usePRNotificationStore.getState()

function setPRNotifications(count: number): void {
  const notifications = Array.from({ length: count }, (_, i) => ({
    id: `pr-${i}`,
    status: 'info' as const,
    message: `Notification ${i}`
  }))
  act(() => {
    usePRNotificationStore.setState({ notifications })
  })
}

function mountFakeStack(height: number): HTMLElement {
  const stack = document.createElement('div')
  stack.setAttribute('data-testid', 'pr-notification-stack')
  Object.defineProperty(stack, 'offsetHeight', {
    configurable: true,
    value: height
  })
  document.body.appendChild(stack)
  return stack
}

function setStackHeight(stack: HTMLElement, height: number): void {
  Object.defineProperty(stack, 'offsetHeight', {
    configurable: true,
    value: height
  })
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('usePRStackTopOffset', () => {
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    act(() => {
      usePRNotificationStore.setState({ ...originalPRState, notifications: [] })
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    act(() => {
      usePRNotificationStore.setState(originalPRState)
    })
  })

  it('returns the baseline 16px offset when there are no PR notifications', () => {
    const { result } = renderHook(() => usePRStackTopOffset())
    expect(result.current).toBe(16)
  })

  it('returns the baseline 16px offset when notifications exist but no stack element is in the DOM', () => {
    // Store says count > 0, but PRNotificationStack is not mounted (e.g.
    // hasn't rendered yet or was unmounted). The hook should gracefully
    // fall back to the baseline rather than throwing.
    setPRNotifications(1)
    const { result } = renderHook(() => usePRStackTopOffset())
    expect(result.current).toBe(16)
  })

  it('returns 16 + stack.offsetHeight + 8 when a PR stack element is present and notifications exist', () => {
    mountFakeStack(100)
    setPRNotifications(1)
    const { result } = renderHook(() => usePRStackTopOffset())
    // 16 (top-4 of the stack) + 100 (measured stack height) + 8 (gap) = 124
    expect(result.current).toBe(124)
  })

  it('re-measures when the ResizeObserver fires (stack grew in place)', () => {
    const stack = mountFakeStack(80)
    setPRNotifications(1)
    const { result } = renderHook(() => usePRStackTopOffset())
    expect(result.current).toBe(16 + 80 + 8)

    // Stack grew — e.g. a card expanded with an action row. Trigger observer.
    setStackHeight(stack, 160)
    act(() => {
      observers[observers.length - 1]?.trigger()
    })
    expect(result.current).toBe(16 + 160 + 8)
  })

  it('returns to baseline when notifications are dismissed', () => {
    mountFakeStack(120)
    setPRNotifications(2)
    const { result, rerender } = renderHook(() => usePRStackTopOffset())
    expect(result.current).toBe(16 + 120 + 8)

    // User dismisses all notifications. PRNotificationStack unmounts, and
    // the hook's effect re-runs because `count` changed.
    setPRNotifications(0)
    rerender()
    expect(result.current).toBe(16)
  })

  it('disconnects the ResizeObserver on unmount', () => {
    mountFakeStack(80)
    setPRNotifications(1)
    const { unmount } = renderHook(() => usePRStackTopOffset())
    const observer = observers[observers.length - 1]
    expect(observer).toBeDefined()
    unmount()
    expect(observer!.disconnect).toHaveBeenCalled()
  })

  it('falls back gracefully when ResizeObserver is not available', () => {
    // Simulate an environment without ResizeObserver (e.g. older test runtime).
    vi.stubGlobal('ResizeObserver', undefined)
    mountFakeStack(64)
    setPRNotifications(1)
    const { result } = renderHook(() => usePRStackTopOffset())
    // Should still do the initial measurement.
    expect(result.current).toBe(16 + 64 + 8)
  })
})
