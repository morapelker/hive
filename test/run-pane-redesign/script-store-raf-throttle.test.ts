import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useScriptStore } from '../../src/renderer/src/stores/useScriptStore'
import { deleteBuffer } from '../../src/renderer/src/lib/output-ring-buffer'

// ---------------------------------------------------------------------------
// Controllable rAF mock — stores callbacks so tests can flush them manually.
// Overrides the synchronous auto-fire mock from test/setup.ts.
// ---------------------------------------------------------------------------
let nextRafId = 1
const pendingCallbacks = new Map<number, FrameRequestCallback>()
let originalRAF: typeof window.requestAnimationFrame
let originalCAF: typeof window.cancelAnimationFrame

function installControllableRAF(): void {
  originalRAF = window.requestAnimationFrame
  originalCAF = window.cancelAnimationFrame

  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback): number => {
    const id = nextRafId++
    pendingCallbacks.set(id, cb)
    return id
  })

  window.cancelAnimationFrame = vi.fn((id: number): void => {
    pendingCallbacks.delete(id)
  })
}

function restoreRAF(): void {
  window.requestAnimationFrame = originalRAF
  window.cancelAnimationFrame = originalCAF
}

/** Flush all pending rAF callbacks (simulates one animation frame). */
function flushRAF(): void {
  const entries = [...pendingCallbacks.entries()]
  pendingCallbacks.clear()
  for (const [, cb] of entries) {
    cb(performance.now())
  }
}

/** Return how many rAF callbacks are currently pending. */
function pendingRAFCount(): number {
  return pendingCallbacks.size
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useScriptStore RAF-throttled version bumps', () => {
  beforeEach(() => {
    useScriptStore.setState({ scriptStates: {} })
    deleteBuffer('wt-raf')
    deleteBuffer('wt-raf-2')
    nextRafId = 1
    pendingCallbacks.clear()
    installControllableRAF()
  })

  afterEach(() => {
    // Flush any pending rAF callbacks so pendingVersionBumps is clean for the next test
    flushRAF()
    restoreRAF()
  })

  test('first appendRunOutput schedules a rAF', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pendingRAFCount()).toBe(1)
  })

  test('multiple appends in the same frame schedule only one rAF', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    store.appendRunOutput('wt-raf', 'line-2')
    store.appendRunOutput('wt-raf', 'line-3')
    // Only one rAF should be scheduled for the same worktreeId
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pendingRAFCount()).toBe(1)
  })

  test('version is NOT bumped until rAF fires', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    store.appendRunOutput('wt-raf', 'line-2')

    // Version should still be 0 (default) — no set() has been called yet
    const state = useScriptStore.getState().scriptStates['wt-raf']
    expect(state?.runOutputVersion ?? 0).toBe(0)
  })

  test('version bumps exactly once when rAF fires', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    store.appendRunOutput('wt-raf', 'line-2')
    store.appendRunOutput('wt-raf', 'line-3')

    flushRAF()

    const v = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(v).toBe(1) // exactly one bump
  })

  test('buffer data is available before rAF fires', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    store.appendRunOutput('wt-raf', 'line-2')

    // Data is in the buffer even though version hasn't bumped
    const output = store.getRunOutput('wt-raf')
    expect(output).toEqual(['line-1', 'line-2'])
  })

  test('after rAF fires, next append schedules a new rAF', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    flushRAF()

    const v1 = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(v1).toBe(1)

    store.appendRunOutput('wt-raf', 'line-2')
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)

    flushRAF()
    const v2 = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(v2).toBe(2)
  })

  test('independent worktrees get independent rAF handles', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'a')
    store.appendRunOutput('wt-raf-2', 'b')

    // Two rAFs: one per worktreeId
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)
    expect(pendingRAFCount()).toBe(2)

    flushRAF()

    const v1 = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    const v2 = useScriptStore.getState().scriptStates['wt-raf-2'].runOutputVersion
    expect(v1).toBe(1)
    expect(v2).toBe(1)
  })

  test('clearRunOutput cancels pending rAF', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    expect(pendingRAFCount()).toBe(1)

    store.clearRunOutput('wt-raf')
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pendingCallbacks.size).toBe(0)
  })

  test('clearRunOutput bumps version synchronously', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    flushRAF() // v = 1

    store.appendRunOutput('wt-raf', 'line-2')
    // rAF pending but not fired, version still 1
    const vBefore = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(vBefore).toBe(1)

    store.clearRunOutput('wt-raf')
    const vAfter = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(vAfter).toBe(2) // synchronous bump
  })

  test('clearRunOutput clears buffer data', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')
    flushRAF()

    store.clearRunOutput('wt-raf')
    const output = store.getRunOutput('wt-raf')
    expect(output).toEqual([])
  })

  test('cancelled rAF does not bump version if it somehow fires', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-raf', 'line-1')

    // Clear cancels the rAF and bumps version to 1
    store.clearRunOutput('wt-raf')
    const vAfterClear = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(vAfterClear).toBe(1)

    // Flush should be a no-op (callback was removed)
    flushRAF()
    const vAfterFlush = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(vAfterFlush).toBe(1) // unchanged
  })

  test('rapid appends result in max one version bump per frame', () => {
    const store = useScriptStore.getState()

    // Simulate 100 rapid appends (like build output)
    for (let i = 0; i < 100; i++) {
      store.appendRunOutput('wt-raf', `line-${i}`)
    }

    // Only one rAF scheduled
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    // Version still 0
    const vBefore = useScriptStore.getState().scriptStates['wt-raf']?.runOutputVersion ?? 0
    expect(vBefore).toBe(0)

    // After flush, exactly one bump
    flushRAF()
    const vAfter = useScriptStore.getState().scriptStates['wt-raf'].runOutputVersion
    expect(vAfter).toBe(1)

    // But all 100 lines are in the buffer
    const output = store.getRunOutput('wt-raf')
    expect(output.length).toBe(100)
    expect(output[0]).toBe('line-0')
    expect(output[99]).toBe('line-99')
  })
})
