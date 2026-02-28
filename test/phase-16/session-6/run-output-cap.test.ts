import { OutputRingBuffer, MAX_CHARS } from '../../../src/renderer/src/lib/output-ring-buffer'
import { deleteBuffer } from '../../../src/renderer/src/lib/output-ring-buffer'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'

// =====================================================
// OutputRingBuffer unit tests
// =====================================================
describe('OutputRingBuffer', () => {
  test('append and toArray preserve order', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    expect(buf.toArray()).toEqual(['A', 'B', 'C'])
  })

  test('toRecentArray returns only most recent entries', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    expect(buf.toRecentArray(2)).toEqual(['C', 'D'])
    expect(buf.toRecentArray(10)).toEqual(['A', 'B', 'C', 'D'])
  })

  test('evicts oldest when char limit exceeded', () => {
    // Use a high capacity so char limit is the binding constraint
    const buf = new OutputRingBuffer(100)
    const bigChunk = 'x'.repeat(100_000)
    buf.append(bigChunk)
    buf.append(bigChunk)
    buf.append(bigChunk) // total = 300K, limit = 200K
    expect(buf.totalChars).toBeLessThanOrEqual(MAX_CHARS)
    expect(buf.truncated).toBe(true)
    const arr = buf.toArray()
    // First entry should be the truncation marker
    expect(arr[0]).toMatch(/truncated/)
  })

  test('evicts oldest when capacity exceeded', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // capacity exceeded, A evicted
    expect(buf.count).toBe(4)
    expect(buf.truncated).toBe(true)
    const arr = buf.toArray()
    // Truncation marker + B, C, D, E
    expect(arr).toContain('B')
    expect(arr).toContain('E')
    expect(arr).not.toContain('A')
  })

  test('wraps around correctly', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // wraps: evicts A
    buf.append('F') // wraps: evicts B
    const arr = buf.toArray()
    const dataEntries = arr.filter((s) => !s.startsWith('\x00'))
    expect(dataEntries).toEqual(['C', 'D', 'E', 'F'])
  })

  test('clear resets all state', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.clear()
    expect(buf.count).toBe(0)
    expect(buf.totalChars).toBe(0)
    expect(buf.truncated).toBe(false)
    expect(buf.toArray()).toEqual([])
  })

  test('most recent entry is always preserved even if it alone exceeds limit', () => {
    const buf = new OutputRingBuffer(100)
    const hugeChunk = 'x'.repeat(600_000) // single chunk > limit
    buf.append(hugeChunk)
    expect(buf.count).toBe(1)
    const arr = buf.toArray()
    expect(arr).toContain(hugeChunk)
  })

  test('truncation marker appears only once at the start', () => {
    const buf = new OutputRingBuffer(4)
    // Fill and overflow multiple times
    for (let i = 0; i < 10; i++) {
      buf.append(`entry-${i}`)
    }
    const arr = buf.toArray()
    const markers = arr.filter((s) => s.startsWith('\x00TRUNC:'))
    expect(markers.length).toBe(1)
    expect(arr[0]).toMatch(/truncated/)
  })

  test('totalChars tracks correctly through appends and evictions', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('abc') // 3 chars
    buf.append('de') // 5 total
    expect(buf.totalChars).toBe(5)

    buf.append('f') // 6 total
    buf.append('gh') // 8 total
    buf.append('ij') // evicts 'abc', total = 7
    expect(buf.totalChars).toBe(7) // de(2) + f(1) + gh(2) + ij(2)
  })

  test('count tracks correctly through appends and evictions', () => {
    const buf = new OutputRingBuffer(3)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    expect(buf.count).toBe(3)
    buf.append('D') // evicts A
    expect(buf.count).toBe(3)
    buf.clear()
    expect(buf.count).toBe(0)
  })

  test('empty buffer returns empty array', () => {
    const buf = new OutputRingBuffer(8)
    expect(buf.toArray()).toEqual([])
    expect(buf.count).toBe(0)
    expect(buf.totalChars).toBe(0)
    expect(buf.truncated).toBe(false)
  })
})

// =====================================================
// useScriptStore integration tests with ring buffer
// =====================================================
describe('useScriptStore with ring buffer', () => {
  beforeEach(() => {
    useScriptStore.setState({ scriptStates: {} })
    deleteBuffer('wt-1')
    deleteBuffer('wt-2')
  })

  test('appendRunOutput increments version', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'hello')
    const v1 = useScriptStore.getState().scriptStates['wt-1'].runOutputVersion
    store.appendRunOutput('wt-1', 'world')
    const v2 = useScriptStore.getState().scriptStates['wt-1'].runOutputVersion
    expect(v2).toBe(v1 + 1)
  })

  test('getRunOutput returns ordered array', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'line 1')
    store.appendRunOutput('wt-1', 'line 2')
    const output = useScriptStore.getState().getRunOutput('wt-1')
    expect(output).toEqual(['line 1', 'line 2'])
  })

  test('clearRunOutput resets buffer and bumps version', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'data')
    const v1 = useScriptStore.getState().scriptStates['wt-1'].runOutputVersion
    store.clearRunOutput('wt-1')
    const v2 = useScriptStore.getState().scriptStates['wt-1'].runOutputVersion
    const output = useScriptStore.getState().getRunOutput('wt-1')
    expect(output).toEqual([])
    expect(v2).toBe(v1 + 1)
  })

  test('special markers (CMD, ERR) are preserved in recent output', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(200_001)
    store.appendRunOutput('wt-1', bigChunk)
    store.appendRunOutput('wt-1', '\x00CMD:pnpm dev')
    store.appendRunOutput('wt-1', 'server started')
    const output = useScriptStore.getState().getRunOutput('wt-1')
    const lastTwo = output.slice(-2)
    expect(lastTwo[0]).toBe('\x00CMD:pnpm dev')
    expect(lastTwo[1]).toBe('server started')
  })

  test('separate worktrees have independent buffers', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'wt1-line')
    store.appendRunOutput('wt-2', 'wt2-line')
    expect(useScriptStore.getState().getRunOutput('wt-1')).toEqual(['wt1-line'])
    expect(useScriptStore.getState().getRunOutput('wt-2')).toEqual(['wt2-line'])
  })

  test('getRunOutput returns empty for unknown worktree', () => {
    const output = useScriptStore.getState().getRunOutput('unknown-wt')
    expect(output).toEqual([])
  })

  test('output under limit is not trimmed', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'short line')
    const output = useScriptStore.getState().getRunOutput('wt-1')
    expect(output).toEqual(['short line'])
  })

  test('output over limit is trimmed from the front', () => {
    const store = useScriptStore.getState()
    // Append chunks that total > MAX_CHARS (200K)
    const bigChunk = 'x'.repeat(100_000)
    for (let i = 0; i < 6; i++) {
      store.appendRunOutput('wt-1', bigChunk)
    }
    const output = useScriptStore.getState().getRunOutput('wt-1')
    // Total data chars should be <= MAX_CHARS
    const dataChars = output
      .filter((s) => !s.startsWith('\x00'))
      .reduce((sum, s) => sum + s.length, 0)
    expect(dataChars).toBeLessThanOrEqual(MAX_CHARS)
    // First entry should be the truncation marker
    expect(output[0]).toMatch(/truncated/)
  })

  test('truncation marker is not duplicated after multiple trims', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(100_000)
    // Append enough to trigger trimming multiple times
    for (let i = 0; i < 12; i++) {
      store.appendRunOutput('wt-1', bigChunk)
    }
    const output = useScriptStore.getState().getRunOutput('wt-1')
    const markers = output.filter((l) => l.startsWith('\x00TRUNC:'))
    expect(markers.length).toBe(1)
    expect(output[0]).toMatch(/truncated/)
  })

  test('most recent entry is always preserved', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(200_001)
    store.appendRunOutput('wt-1', bigChunk)
    store.appendRunOutput('wt-1', 'latest')
    const output = useScriptStore.getState().getRunOutput('wt-1')
    expect(output[output.length - 1]).toBe('latest')
  })
})
