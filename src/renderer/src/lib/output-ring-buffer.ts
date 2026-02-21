const MAX_CHARS = 500_000
const BUFFER_CAPACITY = 50_000 // max entries (50K * ~10 chars avg = 500K)
const TRUNCATION_MARKER = '\x00TRUNC:[older output truncated]'

export class OutputRingBuffer {
  private chunks: (string | null)[]
  private head: number = 0 // next write position
  private tail: number = 0 // oldest valid entry position
  private _count: number = 0 // number of valid entries
  private _totalChars: number = 0
  private _truncated: boolean = false

  constructor(private capacity: number = BUFFER_CAPACITY) {
    this.chunks = new Array(capacity).fill(null)
  }

  append(chunk: string): void {
    // If buffer is full (by entry count), evict oldest
    if (this._count === this.capacity) {
      this.evictOldest()
    }

    // Write at head
    this.chunks[this.head] = chunk
    this._totalChars += chunk.length
    this._count++
    this.head = (this.head + 1) % this.capacity

    // Evict oldest entries until under character limit
    while (this._totalChars > MAX_CHARS && this._count > 1) {
      this.evictOldest()
    }
  }

  private evictOldest(): void {
    const evicted = this.chunks[this.tail]
    if (evicted !== null) {
      this._totalChars -= evicted.length
      this.chunks[this.tail] = null
    }
    this.tail = (this.tail + 1) % this.capacity
    this._count--
    this._truncated = true
  }

  /**
   * Produce an ordered array for rendering.
   * Called only when React needs to render — not on every append.
   */
  toArray(): string[] {
    const result: string[] = []
    if (this._truncated) {
      result.push(TRUNCATION_MARKER)
    }
    for (let i = 0; i < this._count; i++) {
      const chunk = this.chunks[(this.tail + i) % this.capacity]
      if (chunk !== null) result.push(chunk)
    }
    return result
  }

  /**
   * Return only the most recent entries. Used by lightweight consumers
   * that don't need the full history (for example, URL detection).
   */
  toRecentArray(maxEntries: number): string[] {
    if (maxEntries <= 0 || this._count === 0) return []

    const safeMax = Math.min(maxEntries, this._count)
    const start = this._count - safeMax
    const result: string[] = []

    for (let i = start; i < this._count; i++) {
      const chunk = this.chunks[(this.tail + i) % this.capacity]
      if (chunk !== null) result.push(chunk)
    }

    return result
  }

  clear(): void {
    this.chunks.fill(null)
    this.head = 0
    this.tail = 0
    this._count = 0
    this._totalChars = 0
    this._truncated = false
  }

  get totalChars(): number {
    return this._totalChars
  }
  get count(): number {
    return this._count
  }
  get truncated(): boolean {
    return this._truncated
  }
}

// Module-level buffer registry — one per worktree
const buffers = new Map<string, OutputRingBuffer>()

export function getOrCreateBuffer(worktreeId: string): OutputRingBuffer {
  let buf = buffers.get(worktreeId)
  if (!buf) {
    buf = new OutputRingBuffer()
    buffers.set(worktreeId, buf)
  }
  return buf
}

export function deleteBuffer(worktreeId: string): void {
  buffers.delete(worktreeId)
}

export { TRUNCATION_MARKER }
