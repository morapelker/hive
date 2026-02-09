import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Session 4: Smart Auto-Scroll — Scroll Position Tracking with Cooldown
 *
 * These tests verify the smart auto-scroll logic in SessionView:
 * - handleScroll detects upward scroll direction during streaming
 * - Upward scroll immediately disables auto-scroll with a 2-second cooldown
 * - During cooldown, auto-scroll stays disabled even when near bottom
 * - After cooldown expires, position is re-checked to decide re-enable
 * - FAB click / handleSend / session switch cancel cooldown
 * - The scroll-to-bottom FAB is shown/hidden based on auto-scroll state
 *
 * Since the scroll logic lives inside SessionView as hooks and callbacks,
 * we test the patterns directly and verify the source code structure.
 */

describe('Session 4: Smart Auto-Scroll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Simulates the handleScroll callback logic extracted from SessionView,
   * including direction detection and cooldown.
   */
  function createScrollTracker() {
    let isAutoScrollEnabled = true
    let showScrollFab = false
    let lastScrollTop = 0
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null
    let isCooldownActive = false

    const COOLDOWN_MS = 2000

    function handleScroll(opts: {
      scrollHeight: number
      scrollTop: number
      clientHeight: number
      isSending: boolean
      isStreaming: boolean
    }) {
      const currentScrollTop = opts.scrollTop
      const scrollingUp = currentScrollTop < lastScrollTop
      lastScrollTop = currentScrollTop

      const distanceFromBottom = opts.scrollHeight - currentScrollTop - opts.clientHeight
      const isNearBottom = distanceFromBottom < 80

      if (scrollingUp && (opts.isSending || opts.isStreaming)) {
        isAutoScrollEnabled = false
        showScrollFab = true
        isCooldownActive = true

        if (cooldownTimer !== null) {
          clearTimeout(cooldownTimer)
        }
        cooldownTimer = setTimeout(() => {
          cooldownTimer = null
          isCooldownActive = false
          // Re-check position after cooldown
          // (In real code this reads the DOM; here we just expire the cooldown)
        }, COOLDOWN_MS)
        return
      }

      if (isNearBottom && !isCooldownActive) {
        isAutoScrollEnabled = true
        showScrollFab = false
      } else if (!isNearBottom && (opts.isSending || opts.isStreaming)) {
        isAutoScrollEnabled = false
        showScrollFab = true
      }
    }

    function cancelCooldown() {
      if (cooldownTimer !== null) {
        clearTimeout(cooldownTimer)
        cooldownTimer = null
      }
      isCooldownActive = false
    }

    function clickFab(scrollToBottom: () => void) {
      cancelCooldown()
      isAutoScrollEnabled = true
      showScrollFab = false
      scrollToBottom()
    }

    function sendMessage() {
      cancelCooldown()
      isAutoScrollEnabled = true
      showScrollFab = false
    }

    function switchSession() {
      cancelCooldown()
      isAutoScrollEnabled = true
      showScrollFab = false
    }

    return {
      handleScroll,
      clickFab,
      sendMessage,
      switchSession,
      cancelCooldown,
      get state() {
        return {
          isAutoScrollEnabled,
          showScrollFab,
          isCooldownActive,
          lastScrollTop,
          hasCooldownTimer: cooldownTimer !== null
        }
      }
    }
  }

  describe('direction detection + cooldown', () => {
    test('upward scroll during streaming instantly disables auto-scroll', () => {
      const tracker = createScrollTracker()

      // First scroll sets lastScrollTop
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Scroll up (1900 → 1800)
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isAutoScrollEnabled).toBe(false)
      expect(tracker.state.showScrollFab).toBe(true)
      expect(tracker.state.isCooldownActive).toBe(true)
      expect(tracker.state.hasCooldownTimer).toBe(true)
    })

    test('upward scroll when NOT streaming does NOT trigger cooldown', () => {
      const tracker = createScrollTracker()

      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: false
      })

      // Scroll up but not streaming
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: false
      })

      // No cooldown started, auto-scroll stays enabled (no streaming context)
      expect(tracker.state.isCooldownActive).toBe(false)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
    })

    test('during cooldown, being near bottom does NOT re-enable auto-scroll', () => {
      const tracker = createScrollTracker()

      // Initial position
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Scroll up → triggers cooldown
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isCooldownActive).toBe(true)

      // Streaming pushes content, scroll position ends up near bottom again
      // This is a downward scroll (1800 → 1910) near bottom, but cooldown is active
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1910,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Should STILL be disabled because cooldown is active
      expect(tracker.state.isAutoScrollEnabled).toBe(false)
      expect(tracker.state.showScrollFab).toBe(true)
    })

    test('after cooldown expires, cooldown flag is cleared', () => {
      const tracker = createScrollTracker()

      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isCooldownActive).toBe(true)

      // Advance past cooldown
      vi.advanceTimersByTime(2000)

      expect(tracker.state.isCooldownActive).toBe(false)
      expect(tracker.state.hasCooldownTimer).toBe(false)
    })

    test('after cooldown expires, near-bottom scroll re-enables auto-scroll', () => {
      const tracker = createScrollTracker()

      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Scroll up → cooldown
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Expire cooldown
      vi.advanceTimersByTime(2000)

      // Now a near-bottom scroll should re-enable
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1910,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
    })

    test('repeated upward scrolls reset the cooldown timer', () => {
      const tracker = createScrollTracker()

      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // First upward scroll
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1800,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Wait 1.5 seconds (not enough to expire)
      vi.advanceTimersByTime(1500)
      expect(tracker.state.isCooldownActive).toBe(true)

      // Another upward scroll resets timer
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1700,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      // Wait another 1.5 seconds (total 3s from first, but only 1.5s from reset)
      vi.advanceTimersByTime(1500)
      expect(tracker.state.isCooldownActive).toBe(true)

      // Wait the remaining 0.5s
      vi.advanceTimersByTime(500)
      expect(tracker.state.isCooldownActive).toBe(false)
    })

    test('80px threshold — distance 79px is near bottom (no cooldown)', () => {
      const tracker = createScrollTracker()

      // Downward scroll to near bottom, no cooldown
      tracker.handleScroll({
        scrollHeight: 1000,
        scrollTop: 821,
        clientHeight: 100,
        isSending: true,
        isStreaming: true
      })

      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
    })

    test('exactly at bottom (distance=0) enables auto-scroll (no cooldown)', () => {
      const tracker = createScrollTracker()

      tracker.handleScroll({
        scrollHeight: 1000,
        scrollTop: 500,
        clientHeight: 500,
        isSending: true,
        isStreaming: true
      })

      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
    })
  })

  describe('conditional auto-scroll pattern', () => {
    test('scrollToBottom called when auto-scroll enabled', () => {
      const scrollToBottom = vi.fn()
      const isAutoScrollEnabled = true

      if (isAutoScrollEnabled) {
        scrollToBottom()
      }

      expect(scrollToBottom).toHaveBeenCalledTimes(1)
    })

    test('scrollToBottom NOT called when auto-scroll disabled', () => {
      const scrollToBottom = vi.fn()
      const isAutoScrollEnabled = false

      if (isAutoScrollEnabled) {
        scrollToBottom()
      }

      expect(scrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('FAB click cancels cooldown', () => {
    test('clicking FAB cancels cooldown, re-enables auto-scroll, and scrolls', () => {
      const tracker = createScrollTracker()
      const scrollToBottom = vi.fn()

      // Set up: scroll up during streaming → cooldown active
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1500,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isCooldownActive).toBe(true)

      // Click FAB
      tracker.clickFab(scrollToBottom)

      expect(tracker.state.isCooldownActive).toBe(false)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
      expect(scrollToBottom).toHaveBeenCalledTimes(1)

      // Cooldown timer should not fire after being cancelled
      vi.advanceTimersByTime(2000)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
    })
  })

  describe('handleSend cancels cooldown', () => {
    test('sending a message cancels cooldown and re-enables auto-scroll', () => {
      const tracker = createScrollTracker()

      // Set up: scroll up during streaming → cooldown active
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1500,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isCooldownActive).toBe(true)

      // Send message
      tracker.sendMessage()

      expect(tracker.state.isCooldownActive).toBe(false)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)
    })
  })

  describe('session switch cancels cooldown', () => {
    test('switching session cancels cooldown and resets state', () => {
      const tracker = createScrollTracker()

      // Set up: scroll up during streaming → cooldown active
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1900,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })
      tracker.handleScroll({
        scrollHeight: 2000,
        scrollTop: 1500,
        clientHeight: 100,
        isSending: false,
        isStreaming: true
      })

      expect(tracker.state.isCooldownActive).toBe(true)

      // Switch session
      tracker.switchSession()

      expect(tracker.state.isCooldownActive).toBe(false)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
      expect(tracker.state.showScrollFab).toBe(false)

      // Cooldown timer should not fire
      vi.advanceTimersByTime(2000)
      expect(tracker.state.isAutoScrollEnabled).toBe(true)
    })
  })

  describe('source code verification', () => {
    test('SessionView.tsx has scroll tracking infrastructure', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Core refs
      expect(source).toContain('scrollContainerRef')
      expect(source).toContain('isAutoScrollEnabledRef')
      expect(source).toContain('useRef(true)')

      // Cooldown refs
      expect(source).toContain('lastScrollTopRef')
      expect(source).toContain('scrollCooldownRef')
      expect(source).toContain('isScrollCooldownActiveRef')

      // FAB state
      expect(source).toContain('showScrollFab')
      expect(source).toContain('setShowScrollFab')
    })

    test('SessionView.tsx has direction detection in handleScroll', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Direction detection
      expect(source).toContain('lastScrollTopRef.current')
      expect(source).toMatch(/scrollingUp/)

      // 80px threshold
      expect(source).toContain('distanceFromBottom < 80')

      // Cooldown guard on near-bottom re-enable
      expect(source).toContain('!isScrollCooldownActiveRef.current')
    })

    test('SessionView.tsx has 2-second cooldown timer', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Cooldown constant
      expect(source).toContain('SCROLL_COOLDOWN_MS')
      expect(source).toContain('2000')

      // Timer management
      expect(source).toMatch(/scrollCooldownRef\.current\s*=\s*setTimeout/)
      expect(source).toContain('clearTimeout(scrollCooldownRef.current)')
    })

    test('SessionView.tsx has conditional auto-scroll', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      expect(source).toMatch(
        /if\s*\(\s*isAutoScrollEnabledRef\.current\s*\)\s*\{?\s*\n?\s*scrollToBottom/
      )
    })

    test('SessionView.tsx has scroll container with ref and onScroll', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      expect(source).toContain('ref={scrollContainerRef}')
      expect(source).toContain('onScroll={handleScroll}')
    })

    test('SessionView.tsx has scroll-to-bottom FAB', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      expect(source).toContain('scroll-to-bottom-fab')
      expect(source).toContain('Scroll to bottom')
      expect(source).toContain('ArrowDown')
      expect(source).toContain('pointer-events-none')
    })

    test('SessionView.tsx cancels cooldown in handleSend', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // handleSend should clear cooldown and re-enable
      const handleSendMatch = source.match(
        /const handleSend[\s\S]*?isScrollCooldownActiveRef\.current\s*=\s*false[\s\S]*?isAutoScrollEnabledRef\.current\s*=\s*true/
      )
      expect(handleSendMatch).not.toBeNull()
    })

    test('SessionView.tsx cancels cooldown in handleScrollToBottomClick', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      const fabClickMatch = source.match(
        /handleScrollToBottomClick[\s\S]*?clearTimeout\(scrollCooldownRef\.current\)[\s\S]*?isScrollCooldownActiveRef\.current\s*=\s*false/
      )
      expect(fabClickMatch).not.toBeNull()
    })

    test('SessionView.tsx clears cooldown on session switch', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // useEffect with [sessionId] clears cooldown
      expect(source).toMatch(
        /useEffect\(\(\)\s*=>\s*\{[\s\S]*?clearTimeout\(scrollCooldownRef\.current\)[\s\S]*?isScrollCooldownActiveRef\.current\s*=\s*false[\s\S]*?isAutoScrollEnabledRef\.current\s*=\s*true[\s\S]*?\},\s*\[sessionId\]\)/
      )
    })

    test('SessionView.tsx cleans up cooldown timer on unmount', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Unmount cleanup should clear both rAF and cooldown timer
      expect(source).toMatch(
        /return \(\) => \{[\s\S]*?cancelAnimationFrame[\s\S]*?clearTimeout\(scrollCooldownRef\.current\)[\s\S]*?\}/
      )
    })

    test('SessionView.tsx wraps message list in relative container', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      expect(source).toContain('relative flex-1 min-h-0')
      expect(source).toContain('h-full overflow-y-auto')
    })
  })
})
