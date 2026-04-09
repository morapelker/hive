import { describe, test, expect } from 'vitest'

function createScrollTracker() {
  let isAutoScrollEnabled = true
  let showScrollFab = false
  let userHasScrolledUp = false
  let lastScrollTop = 0
  let manualScrollIntent = false
  let pointerDownInScroller = false
  let isProgrammaticScroll = false

  function consumeScroll(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    opts: { isSending: boolean; isStreaming: boolean }
  ) {
    const previousScrollTop = lastScrollTop
    lastScrollTop = scrollTop
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const isNearBottom = distanceFromBottom < 80
    const hasManualIntent = manualScrollIntent || pointerDownInScroller
    const isManualScrollUp = hasManualIntent && scrollTop < previousScrollTop

    if (isProgrammaticScroll) {
      manualScrollIntent = false
      return
    }

    if (isManualScrollUp && (opts.isSending || opts.isStreaming)) {
      isAutoScrollEnabled = false
      showScrollFab = true
      userHasScrolledUp = true
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

    if (!isNearBottom && (opts.isSending || opts.isStreaming)) {
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
    handleScroll(
      scrollTop: number,
      scrollHeight: number,
      clientHeight: number,
      opts: { isSending: boolean; isStreaming: boolean }
    ) {
      consumeScroll(scrollTop, scrollHeight, clientHeight, opts)
    },
    clickFab() {
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
      manualScrollIntent = false
      pointerDownInScroller = false
    },
    sendMessage() {
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
      manualScrollIntent = false
      pointerDownInScroller = false
    },
    switchSession() {
      isAutoScrollEnabled = true
      showScrollFab = false
      userHasScrolledUp = false
      manualScrollIntent = false
      pointerDownInScroller = false
      isProgrammaticScroll = false
      lastScrollTop = 0
    },
    get state() {
      return {
        isAutoScrollEnabled,
        showScrollFab,
        userHasScrolledUp,
        lastScrollTop
      }
    }
  }
}

describe('Session 4: Smart Auto-Scroll', () => {
  test('programmatic scroll events during streaming do not disable auto-scroll', () => {
    const tracker = createScrollTracker()

    tracker.beginProgrammaticScroll()
    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.handleScroll(80, 700, 400, { isSending: false, isStreaming: true })
    tracker.endProgrammaticScroll()

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.userHasScrolledUp).toBe(false)
  })

  test('content growth with no manual intent does not show the FAB', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.handleScroll(100, 900, 400, { isSending: false, isStreaming: true })

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('manual wheel scroll during streaming disables auto-scroll', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.wheel()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })

    expect(tracker.state.isAutoScrollEnabled).toBe(false)
    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)
  })

  test('small manual upward scroll near bottom still disables auto-scroll', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.wheel()
    tracker.handleScroll(70, 520, 400, { isSending: false, isStreaming: true })

    expect(tracker.state.isAutoScrollEnabled).toBe(false)
    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)
  })

  test('manual scrollbar drag during streaming disables auto-scroll', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.pointerDown()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })
    tracker.pointerUp()

    expect(tracker.state.isAutoScrollEnabled).toBe(false)
    expect(tracker.state.showScrollFab).toBe(true)
  })

  test('returning near bottom after manual scroll re-enables auto-scroll', () => {
    const tracker = createScrollTracker()

    tracker.handleScroll(100, 500, 400, { isSending: false, isStreaming: true })
    tracker.wheel()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })

    tracker.wheel()
    tracker.handleScroll(430, 500, 400, { isSending: false, isStreaming: true })

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.userHasScrolledUp).toBe(false)
  })

  test('sending a message resets the scroll lockout state', () => {
    const tracker = createScrollTracker()

    tracker.wheel()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })
    tracker.sendMessage()

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('clicking the FAB resets the scroll lockout state', () => {
    const tracker = createScrollTracker()

    tracker.wheel()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })
    tracker.clickFab()

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('switching session resets the scroll tracking state', () => {
    const tracker = createScrollTracker()

    tracker.wheel()
    tracker.handleScroll(0, 500, 400, { isSending: false, isStreaming: true })
    tracker.switchSession()

    expect(tracker.state.isAutoScrollEnabled).toBe(true)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.lastScrollTop).toBe(0)
  })

  test('source uses explicit user-intent and programmatic-scroll guards', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    expect(source).toContain('isProgrammaticScrollRef')
    expect(source).toContain('manualScrollIntentRef')
    expect(source).toContain('pointerDownInScrollerRef')
    expect(source).toContain("scrollToBottom('instant')")
    expect(source).toContain('onWheel={handleScrollWheel}')
    expect(source).toContain('onPointerDown={handleScrollPointerDown}')
  })
})
