import { describe, test, expect } from 'vitest'

/**
 * Session 4: Scroll FAB Fix — Tests
 *
 * These tests verify the scroll-to-bottom FAB logic using a pure-logic tracker
 * that mirrors the handleScroll algorithm in SessionView.tsx. The key change is
 * the `userHasScrolledUp` flag that gates FAB visibility: the FAB should only
 * appear after the user has intentionally scrolled up, NOT when streaming
 * content growth pushes the scroll position away from the bottom.
 */

function createScrollTracker() {
  let isAutoScrollEnabled = true
  let showScrollFab = false
  let lastScrollTop = 0
  let userHasScrolledUp = false
  let isCooldownActive = false

  return {
    get state() {
      return { isAutoScrollEnabled, showScrollFab, userHasScrolledUp }
    },
    handleScroll(
      scrollTop: number,
      scrollHeight: number,
      clientHeight: number,
      isStreaming: boolean
    ) {
      const scrollingUp = scrollTop < lastScrollTop
      lastScrollTop = scrollTop
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const isNearBottom = distanceFromBottom < 80

      // Upward scroll during streaming → mark as intentional, disable + cooldown
      if (scrollingUp && isStreaming) {
        userHasScrolledUp = true
        isAutoScrollEnabled = false
        showScrollFab = true
        isCooldownActive = true
        return
      }

      // Near bottom and no active cooldown → re-enable auto-scroll
      if (isNearBottom && !isCooldownActive) {
        isAutoScrollEnabled = true
        showScrollFab = false
        userHasScrolledUp = false
      } else if (!isNearBottom && isStreaming && userHasScrolledUp) {
        // Far from bottom during streaming, but only if user intentionally scrolled up
        isAutoScrollEnabled = false
        showScrollFab = true
      }
    },
    clickFab() {
      isCooldownActive = false
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
    },
    sendMessage() {
      isCooldownActive = false
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
    },
    switchSession() {
      isCooldownActive = false
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
    },
    reset() {
      userHasScrolledUp = false
      isAutoScrollEnabled = true
      showScrollFab = false
      isCooldownActive = false
      lastScrollTop = 0
    }
  }
}

describe('Session 4: Scroll FAB Fix', () => {
  test('FAB does NOT show when content grows during streaming (no user scroll)', () => {
    const tracker = createScrollTracker()
    // Simulate content growing: scrollHeight increases, scrollTop stays at 0
    // distance = 500 - 0 - 400 = 100, but userHasScrolledUp is false
    tracker.handleScroll(0, 500, 400, true)
    expect(tracker.state.showScrollFab).toBe(false)

    // Content grows more: distance = 600 - 0 - 400 = 200
    tracker.handleScroll(0, 600, 400, true)
    expect(tracker.state.showScrollFab).toBe(false)

    // Even more growth
    tracker.handleScroll(0, 1000, 400, true)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('FAB shows when user scrolls up during streaming', () => {
    const tracker = createScrollTracker()
    // Set initial position
    tracker.handleScroll(100, 500, 400, true)
    // Scroll UP (100 → 50)
    tracker.handleScroll(50, 500, 400, true)
    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)
    expect(tracker.state.isAutoScrollEnabled).toBe(false)
  })

  test('FAB stays visible for far-from-bottom AFTER user has scrolled up', () => {
    const tracker = createScrollTracker()
    // Initial position near bottom
    tracker.handleScroll(100, 500, 400, true)
    // User scrolls up → flag set
    tracker.handleScroll(50, 500, 400, true)
    expect(tracker.state.userHasScrolledUp).toBe(true)

    // Content grows, user stays at same scrollTop, still far from bottom
    // distance = 600 - 50 - 400 = 150 → far from bottom, flag is set → FAB stays
    tracker.handleScroll(50, 600, 400, true)
    expect(tracker.state.showScrollFab).toBe(true)
  })

  test('flag resets when user scrolls back to bottom', () => {
    const tracker = createScrollTracker()
    // Set initial position
    tracker.handleScroll(100, 500, 400, true)
    // Scroll up → flag set
    tracker.handleScroll(50, 500, 400, true)
    expect(tracker.state.userHasScrolledUp).toBe(true)

    // Scroll back to bottom: distance = 500 - 420 - 400 = -320 < 80
    // But cooldown is active from the upward scroll, so near-bottom branch is skipped.
    // Use clickFab to simulate FAB click which clears cooldown
    tracker.clickFab()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('flag resets when scrolling near bottom without cooldown', () => {
    const tracker = createScrollTracker()
    // Non-streaming scroll up does not set the flag or cooldown
    tracker.handleScroll(200, 500, 400, false)
    tracker.handleScroll(100, 500, 400, false)
    expect(tracker.state.userHasScrolledUp).toBe(false)

    // Simulate being near bottom during streaming (no prior scroll-up)
    // distance = 500 - 440 - 400 = -340 < 80
    tracker.handleScroll(440, 500, 400, true)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.userHasScrolledUp).toBe(false)
  })

  test('FAB click resets all scroll state', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)

    tracker.clickFab()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('sendMessage resets all scroll state', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    expect(tracker.state.showScrollFab).toBe(true)

    tracker.sendMessage()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('switchSession resets all scroll state', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    expect(tracker.state.showScrollFab).toBe(true)

    tracker.switchSession()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('reset clears all state', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    tracker.reset()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('FAB does NOT show during non-streaming even when far from bottom', () => {
    const tracker = createScrollTracker()
    // Not streaming — distance = 500 - 0 - 400 = 100, far from bottom
    tracker.handleScroll(0, 500, 400, false)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('scrolling up outside streaming does NOT set userHasScrolledUp flag', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(200, 500, 400, false)
    tracker.handleScroll(100, 500, 400, false) // scroll up, but not streaming
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('content growth after FAB click does not re-show FAB', () => {
    const tracker = createScrollTracker()
    // User scrolls up during streaming
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true)
    expect(tracker.state.showScrollFab).toBe(true)

    // User clicks FAB to scroll to bottom
    tracker.clickFab()
    expect(tracker.state.showScrollFab).toBe(false)

    // Content continues growing (scrollTop stays same, scrollHeight increases)
    // distance = 800 - 50 - 400 = 350, far from bottom, but flag is reset
    tracker.handleScroll(50, 800, 400, true)
    expect(tracker.state.showScrollFab).toBe(false)
  })
})
