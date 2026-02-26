import {
  OutputRingBuffer,
  TRUNCATION_MARKER
} from '../../src/renderer/src/lib/output-ring-buffer'

describe('OutputRingBuffer.get() and renderCount', () => {
  // ── renderCount ──────────────────────────────────────────────────

  test('renderCount is 0 for empty buffer', () => {
    const buf = new OutputRingBuffer(8)
    expect(buf.renderCount).toBe(0)
  })

  test('renderCount equals count when not truncated', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    expect(buf.truncated).toBe(false)
    expect(buf.renderCount).toBe(3)
    expect(buf.renderCount).toBe(buf.count)
  })

  test('renderCount equals count + 1 when truncated', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // evicts A, truncated = true
    expect(buf.truncated).toBe(true)
    expect(buf.count).toBe(4)
    expect(buf.renderCount).toBe(5) // 4 data + 1 marker
  })

  // ── get() — non-truncated ────────────────────────────────────────

  test('get(0) returns first data entry when NOT truncated', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('first')
    buf.append('second')
    expect(buf.get(0)).toBe('first')
  })

  test('get(index) returns correct entries when NOT truncated', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    expect(buf.get(0)).toBe('A')
    expect(buf.get(1)).toBe('B')
    expect(buf.get(2)).toBe('C')
  })

  // ── get() — truncated ───────────────────────────────────────────

  test('get(0) returns truncation marker when truncated', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // evicts A
    expect(buf.truncated).toBe(true)
    expect(buf.get(0)).toBe(TRUNCATION_MARKER)
  })

  test('get(1) returns first data entry when truncated', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // evicts A → data is [B, C, D, E]
    expect(buf.get(1)).toBe('B')
    expect(buf.get(2)).toBe('C')
    expect(buf.get(3)).toBe('D')
    expect(buf.get(4)).toBe('E')
  })

  // ── get() — out-of-bounds ───────────────────────────────────────

  test('get(index) returns null for out-of-bounds', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    expect(buf.get(2)).toBeNull()
    expect(buf.get(100)).toBeNull()
  })

  test('get(index) returns null for negative indices', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    expect(buf.get(-1)).toBeNull()
    expect(buf.get(-100)).toBeNull()
  })

  test('get(index) returns null on empty buffer', () => {
    const buf = new OutputRingBuffer(8)
    expect(buf.get(0)).toBeNull()
  })

  // ── get() — wrap-around ─────────────────────────────────────────

  test('get(index) works correctly after buffer wraps around', () => {
    const buf = new OutputRingBuffer(4)
    // Fill and overflow so head wraps around
    buf.append('A') // slot 0
    buf.append('B') // slot 1
    buf.append('C') // slot 2
    buf.append('D') // slot 3
    buf.append('E') // slot 0 (wraps), evicts A
    buf.append('F') // slot 1 (wraps), evicts B

    // Data is now [C, D, E, F], truncated
    expect(buf.truncated).toBe(true)
    expect(buf.get(0)).toBe(TRUNCATION_MARKER)
    expect(buf.get(1)).toBe('C')
    expect(buf.get(2)).toBe('D')
    expect(buf.get(3)).toBe('E')
    expect(buf.get(4)).toBe('F')
    expect(buf.get(5)).toBeNull() // out-of-bounds
  })

  test('get(index) works after multiple full wrap-arounds', () => {
    const buf = new OutputRingBuffer(3)
    // Append 10 items into a capacity-3 buffer
    for (let i = 0; i < 10; i++) {
      buf.append(`item-${i}`)
    }
    // Last 3 should be item-7, item-8, item-9
    expect(buf.count).toBe(3)
    expect(buf.truncated).toBe(true)
    expect(buf.renderCount).toBe(4)
    expect(buf.get(0)).toBe(TRUNCATION_MARKER)
    expect(buf.get(1)).toBe('item-7')
    expect(buf.get(2)).toBe('item-8')
    expect(buf.get(3)).toBe('item-9')
  })

  // ── consistency with toArray() ──────────────────────────────────

  test('get(index) is consistent with toArray()[index] for all valid indices', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('alpha')
    buf.append('beta')
    buf.append('gamma')
    buf.append('delta')

    const arr = buf.toArray()
    for (let i = 0; i < arr.length; i++) {
      expect(buf.get(i)).toBe(arr[i])
    }
    // One past the end should be null
    expect(buf.get(arr.length)).toBeNull()
  })

  test('get(index) is consistent with toArray() when truncated', () => {
    const buf = new OutputRingBuffer(4)
    for (let i = 0; i < 8; i++) {
      buf.append(`line-${i}`)
    }

    const arr = buf.toArray()
    expect(arr.length).toBe(buf.renderCount)

    for (let i = 0; i < arr.length; i++) {
      expect(buf.get(i)).toBe(arr[i])
    }
    expect(buf.get(arr.length)).toBeNull()
  })

  test('get(index) is consistent with toArray() after wrap-around', () => {
    const buf = new OutputRingBuffer(5)
    // Append 12 items into capacity-5 to force multiple wraps
    for (let i = 0; i < 12; i++) {
      buf.append(`v${i}`)
    }

    const arr = buf.toArray()
    expect(arr.length).toBe(buf.renderCount)

    for (let i = 0; i < arr.length; i++) {
      expect(buf.get(i)).toBe(arr[i])
    }
  })

  // ── renderCount after clear ─────────────────────────────────────

  test('renderCount resets to 0 after clear', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // truncated
    expect(buf.renderCount).toBe(5)
    buf.clear()
    expect(buf.renderCount).toBe(0)
    expect(buf.get(0)).toBeNull()
  })
})
