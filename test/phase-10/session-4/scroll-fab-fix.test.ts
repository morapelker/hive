import { describe, test, expect } from 'vitest'

function createScrollTracker() {
  let isAutoScrollEnabled = true
  let showScrollFab = false
  let userHasScrolledUp = false
  let manualScrollIntent = false
  let pointerDownInScroller = false
  let isProgrammaticScroll = false

  function handleScroll(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    isStreaming: boolean
  ) {
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const isNearBottom = distanceFromBottom < 80
    const hasManualIntent = manualScrollIntent || pointerDownInScroller

    if (isProgrammaticScroll) {
      manualScrollIntent = false
      return
    }

    if (isNearBottom && hasManualIntent) {
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
      manualScrollIntent = false
      return
    }

    if (!hasManualIntent) {
      return
    }

    if (!isNearBottom && isStreaming) {
      isAutoScrollEnabled = false
      showScrollFab = true
      userHasScrolledUp = true
    }

    manualScrollIntent = false
  }

  return {
    wheel() {
      manualScrollIntent = true
    },
    pointerDown() {
      pointerDownInScroller = true
    },
    pointerUp() {
      pointerDownInScroller = false
      manualScrollIntent = false
    },
    beginProgrammaticScroll() {
      isProgrammaticScroll = true
    },
    endProgrammaticScroll() {
      isProgrammaticScroll = false
    },
    handleScroll,
    clickFab() {
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
      manualScrollIntent = false
      pointerDownInScroller = false
    },
    get state() {
      return { isAutoScrollEnabled, showScrollFab, userHasScrolledUp }
    }
  }
}

describe('Session 4: Scroll FAB Fix', () => {
  test('FAB does not show when content grows during streaming with no user scroll', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(100, 700, 400, true)
    tracker.handleScroll(100, 1000, 400, true)

    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('rapid successive programmatic scrollToBottom calls never mark the user as scrolled up', () => {
    const tracker = createScrollTracker()

    tracker.beginProgrammaticScroll()
    tracker.handleScroll(120, 500, 400, true)
    tracker.handleScroll(110, 650, 400, true)
    tracker.handleScroll(130, 750, 400, true)
    tracker.endProgrammaticScroll()

    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })

  test('FAB shows only after explicit user scroll intent', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, true)
    tracker.wheel()
    tracker.handleScroll(20, 500, 400, true)

    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)
  })

  test('scrollbar dragging counts as explicit user scroll intent', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, true)
    tracker.pointerDown()
    tracker.handleScroll(10, 500, 400, true)
    tracker.pointerUp()

    expect(tracker.state.showScrollFab).toBe(true)
  })

  test('content growth after FAB click does not re-show FAB', () => {
    const tracker = createScrollTracker()

    tracker.wheel()
    tracker.handleScroll(20, 500, 400, true)
    expect(tracker.state.showScrollFab).toBe(true)

    tracker.clickFab()
    tracker.handleScroll(20, 900, 400, true)

    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })
})
