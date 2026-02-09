import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Session 3: Adaptive Streaming Flush
 *
 * These tests verify that the streaming flush machinery in SessionView uses
 * requestAnimationFrame instead of setTimeout for text updates, while tool
 * card updates continue to flush immediately.
 *
 * Since the flush logic lives inside the SessionView React component (via
 * useCallback/useRef hooks), we test it by reading the source code to confirm
 * the rAF-based implementation, and by testing the rAF/cancelAnimationFrame
 * interaction patterns directly.
 */

describe('Session 3: Adaptive Streaming Flush', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>
  let rafIdCounter: number
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame

  beforeEach(() => {
    rafCallbacks = new Map()
    rafIdCounter = 0

    // Save originals
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame

    // Mock requestAnimationFrame
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
      const id = ++rafIdCounter
      rafCallbacks.set(id, callback)
      return id
    })

    // Mock cancelAnimationFrame
    globalThis.cancelAnimationFrame = vi.fn((id: number): void => {
      rafCallbacks.delete(id)
    })
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
    vi.restoreAllMocks()
  })

  /** Helper: fire all pending rAF callbacks */
  function flushRAF(): void {
    const callbacks = [...rafCallbacks.entries()]
    rafCallbacks.clear()
    for (const [, cb] of callbacks) {
      cb(performance.now())
    }
  }

  describe('scheduleFlush pattern (rAF-based)', () => {
    test('uses requestAnimationFrame not setTimeout', () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

      // Simulate the scheduleFlush pattern from SessionView
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      scheduleFlush()

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
      expect(setTimeoutSpy).not.toHaveBeenCalled()

      setTimeoutSpy.mockRestore()
    })

    test('batches multiple calls within same frame', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      // Call scheduleFlush 5 times rapidly
      scheduleFlush()
      scheduleFlush()
      scheduleFlush()
      scheduleFlush()
      scheduleFlush()

      // requestAnimationFrame should only be called once
      expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

      // Flush the rAF callback
      flushRAF()

      // flushStreamingState should be called exactly once
      expect(flushStreamingState).toHaveBeenCalledTimes(1)
    })

    test('flushes streaming state on animation frame', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      scheduleFlush()

      // Before frame fires, flushStreamingState should not be called
      expect(flushStreamingState).not.toHaveBeenCalled()

      // Fire the rAF callback
      flushRAF()

      // After frame, flushStreamingState should be called
      expect(flushStreamingState).toHaveBeenCalledTimes(1)

      // rafRef should be reset to null (allows new schedule)
      expect(rafRef).toBeNull()
    })

    test('allows new schedule after frame fires', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      // First schedule
      scheduleFlush()
      flushRAF()
      expect(flushStreamingState).toHaveBeenCalledTimes(1)

      // Second schedule (should work since rafRef was reset)
      scheduleFlush()
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2)

      flushRAF()
      expect(flushStreamingState).toHaveBeenCalledTimes(2)
    })
  })

  describe('immediateFlush pattern (cancels pending rAF)', () => {
    test('cancels pending rAF and flushes synchronously', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      const immediateFlush = (): void => {
        if (rafRef !== null) {
          cancelAnimationFrame(rafRef)
          rafRef = null
        }
        flushStreamingState()
      }

      // Schedule a flush (sets rafRef)
      scheduleFlush()
      expect(rafRef).not.toBeNull()

      // Call immediateFlush
      immediateFlush()

      // cancelAnimationFrame should have been called
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)

      // flushStreamingState should be called synchronously
      expect(flushStreamingState).toHaveBeenCalledTimes(1)

      // rafRef should be null
      expect(rafRef).toBeNull()
    })

    test('works when no pending rAF', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const immediateFlush = (): void => {
        if (rafRef !== null) {
          cancelAnimationFrame(rafRef)
          rafRef = null
        }
        flushStreamingState()
      }

      // rafRef is null — no pending rAF
      immediateFlush()

      // cancelAnimationFrame should NOT be called
      expect(cancelAnimationFrame).not.toHaveBeenCalled()

      // flushStreamingState should still be called
      expect(flushStreamingState).toHaveBeenCalledTimes(1)
    })

    test('prevents scheduled rAF callback from firing', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      const immediateFlush = (): void => {
        if (rafRef !== null) {
          cancelAnimationFrame(rafRef)
          rafRef = null
        }
        flushStreamingState()
      }

      // Schedule, then immediately flush
      scheduleFlush()
      immediateFlush()

      // flushStreamingState called once (by immediateFlush)
      expect(flushStreamingState).toHaveBeenCalledTimes(1)

      // Now fire any remaining rAF callbacks — should be none
      flushRAF()

      // Still only called once — the scheduled callback was canceled
      expect(flushStreamingState).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanup pattern (unmount)', () => {
    test('cancels pending rAF on cleanup', () => {
      let rafRef: number | null = null

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
          })
        }
      }

      // Simulate scheduling
      scheduleFlush()
      const scheduledId = rafRef

      // Simulate unmount cleanup
      if (rafRef !== null) {
        cancelAnimationFrame(rafRef)
      }

      expect(cancelAnimationFrame).toHaveBeenCalledWith(scheduledId)
    })

    test('no error when cleaning up with no pending rAF', () => {
      const rafRef: number | null = null

      // Simulate unmount cleanup with no pending rAF
      expect(() => {
        if (rafRef !== null) {
          cancelAnimationFrame(rafRef)
        }
      }).not.toThrow()

      // cancelAnimationFrame should not have been called
      expect(cancelAnimationFrame).not.toHaveBeenCalled()
    })
  })

  describe('resetStreamingState pattern', () => {
    test('cancels pending rAF during reset', () => {
      let rafRef: number | null = null
      const flushStreamingState = vi.fn()

      const scheduleFlush = (): void => {
        if (rafRef === null) {
          rafRef = requestAnimationFrame(() => {
            rafRef = null
            flushStreamingState()
          })
        }
      }

      const resetStreamingState = (): void => {
        if (rafRef !== null) {
          cancelAnimationFrame(rafRef)
          rafRef = null
        }
        // ... other reset logic
      }

      // Schedule a flush
      scheduleFlush()
      expect(rafRef).not.toBeNull()

      // Reset
      resetStreamingState()

      // cancelAnimationFrame should have been called
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
      expect(rafRef).toBeNull()

      // Flushing rAF should not trigger any callbacks
      flushRAF()
      expect(flushStreamingState).not.toHaveBeenCalled()
    })
  })

  describe('source code verification', () => {
    test('SessionView.tsx uses rafRef not throttleRef', async () => {
      // Read the actual source file to verify no setTimeout/clearTimeout in flush machinery
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Verify rAF-based refs exist
      expect(source).toContain('rafRef')
      expect(source).toContain('requestAnimationFrame')
      expect(source).toContain('cancelAnimationFrame')

      // Verify no throttleRef remains in the streaming machinery
      expect(source).not.toContain('throttleRef')

      // Verify scheduleFlush uses rAF
      const scheduleFlushMatch = source.match(/const scheduleFlush[\s\S]*?requestAnimationFrame/)
      expect(scheduleFlushMatch).not.toBeNull()

      // Verify immediateFlush uses cancelAnimationFrame
      const immediateFlushMatch = source.match(/const immediateFlush[\s\S]*?cancelAnimationFrame/)
      expect(immediateFlushMatch).not.toBeNull()

      // Verify no setTimeout(100) in the flush pattern
      expect(source).not.toMatch(/scheduleFlush[\s\S]*?setTimeout[\s\S]*?100/)
    })
  })
})
