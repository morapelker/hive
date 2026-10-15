import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Append-only JSONL writer for performance logs. Records are queued in memory and flushed
 * in one `appendFileSync` per flush so a burst of slow-op records costs one syscall, and the
 * file is rotated (`.1`, `.2`, …) once it crosses `maxBytes` so a week of logging stays bounded.
 */
export interface PerfLogWriterOptions {
  readonly dir: string
  readonly fileName: string
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
  readonly flushIntervalMs?: number
  /** Flush as soon as this many records are queued (a burst of slow ops). */
  readonly flushAtQueueSize?: number
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
  readonly onError?: (error: unknown) => void
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_ROTATED = 3
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
const DEFAULT_FLUSH_AT = 200

export class PerfLogWriter {
  readonly filePath: string
  private readonly dir: string
  private readonly maxBytes: number
  private readonly maxRotatedFiles: number
  private readonly flushIntervalMs: number
  private readonly flushAtQueueSize: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly onError?: (error: unknown) => void
  private queue: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirReady = false
  private bytesSinceStatCheck = 0
  private knownSize: number | null = null
  private closed = false

  constructor(options: PerfLogWriterOptions) {
    this.dir = options.dir
    this.filePath = join(options.dir, options.fileName)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.flushAtQueueSize = options.flushAtQueueSize ?? DEFAULT_FLUSH_AT
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    this.onError = options.onError
  }

  write(record: Record<string, unknown>): void {
    if (this.closed) return
    let line: string
    try {
      line = JSON.stringify(record)
    } catch (error) {
      this.onError?.(error)
      return
    }
    this.queue.push(line)
    if (this.queue.length >= this.flushAtQueueSize) {
      this.flush()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = this.setTimeoutFn(() => {
        this.flushTimer = null
        this.flush()
      }, this.flushIntervalMs)
      // Never keep the process alive just to flush diagnostics.
      ;(this.flushTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Writes everything queued so far. Safe to call from a quit hook. */
  flush(): void {
    if (this.flushTimer) {
      this.clearTimeoutFn(this.flushTimer)
      this.flushTimer = null
    }
    if (this.queue.length === 0) return
    const chunk = this.queue.join('\n') + '\n'
    this.queue = []
    try {
      this.ensureDir()
      this.rotateIfNeeded(chunk.length)
      appendFileSync(this.filePath, chunk)
    } catch (error) {
      this.onError?.(error)
    }
  }

  close(): void {
    this.flush()
    this.closed = true
  }

  queuedCount(): number {
    return this.queue.length
  }

  private ensureDir(): void {
    if (this.dirReady) return
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.dirReady = true
  }

  private rotateIfNeeded(incomingBytes: number): void {
    // stat() once per ~1MB written (and on the first flush) rather than on every flush.
    this.bytesSinceStatCheck += incomingBytes
    if (this.knownSize !== null && this.bytesSinceStatCheck < 1024 * 1024) {
      this.knownSize += incomingBytes
      if (this.knownSize < this.maxBytes) return
    }
    this.bytesSinceStatCheck = 0
    if (!existsSync(this.filePath)) {
      this.knownSize = incomingBytes
      return
    }
    const size = statSync(this.filePath).size
    if (size + incomingBytes < this.maxBytes) {
      this.knownSize = size + incomingBytes
      return
    }
    this.knownSize = incomingBytes
    for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`
      if (!existsSync(from)) continue
      try {
        renameSync(from, `${this.filePath}.${i + 1}`)
      } catch {
        // ignore: a missing rotation slot is not worth failing diagnostics over
      }
    }
    try {
      renameSync(this.filePath, `${this.filePath}.1`)
    } catch {
      // ignore
    }
  }
}
