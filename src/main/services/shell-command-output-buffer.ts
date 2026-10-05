import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createLogger } from './logger'
import {
  SHELL_COMMAND_LOG_CAP_BYTES,
  SHELL_COMMAND_LOG_TRUNCATED_MARKER
} from './shell-command-run-host'

const log = createLogger({ component: 'ShellCommandOutputBuffer' })

/** Reads of a log tail are chunked; the head cut looks for a newline this far in. */
const READ_CHUNK_BYTES = 64 * 1024
const SNAPSHOT_HEAD_CUT_CHARS = 4096
const TAIL_HEAD_CUT_CHARS = 64 * 1024

interface RetainedChunk {
  text: string
  bytes: number
}

/**
 * Drops the first bytes of `buffer` so that at most `cap` bytes remain, then skips any
 * UTF-8 continuation bytes so the decoded text does not start with a broken character.
 */
function utf8Tail(buffer: Buffer, cap: number): string {
  let start = Math.max(0, buffer.length - cap)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/** Cuts the head of a truncated transcript at its first newline (when one is near). */
function cutAtFirstNewline(text: string, within: number): string {
  const index = text.indexOf('\n')
  return index !== -1 && index < within ? text.slice(index + 1) : text
}

/**
 * A capped transcript of one shell-command run with coalesced publishing. The run
 * registry uses it in both modes: every output chunk goes into a ring (at most
 * `capBytes` retained) and into a pending batch that is published once per
 * setImmediate tick. In in-app mode the buffer also owns the run's output.log; in
 * detached mode script(1) writes the log and `logFile` stays null.
 *
 * File writes are synchronous on purpose: one write per coalesced tick keeps ordering
 * trivial and the quit path (flush, then exit) correct. File errors never reach the
 * data path.
 */
export class ShellCommandOutputBuffer {
  private readonly capBytes: number
  private readonly logFile: string | null
  private readonly publish: (chunk: string) => void
  private chunks: RetainedChunk[] = []
  private retainedBytes = 0
  private pending: string[] = []
  private immediate: NodeJS.Immediate | null = null
  private fd: number | null = null
  private fileBytes = 0
  private fileErrorLogged = false
  private closed = false
  private wasTruncated = false

  constructor(opts: {
    capBytes?: number
    logFile?: string | null
    publish: (chunk: string) => void
  }) {
    this.capBytes = opts.capBytes ?? SHELL_COMMAND_LOG_CAP_BYTES
    this.logFile = opts.logFile ?? null
    this.publish = opts.publish
  }

  /** True once output was dropped from the head of the retained transcript. */
  get truncated(): boolean {
    return this.wasTruncated
  }

  append(chunk: string): void {
    if (this.closed || chunk === '') return
    let text = chunk
    let bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.capBytes) {
      text = utf8Tail(Buffer.from(text, 'utf8'), this.capBytes)
      bytes = Buffer.byteLength(text, 'utf8')
      this.wasTruncated = true
    }
    this.chunks.push({ text, bytes })
    this.retainedBytes += bytes
    while (this.retainedBytes > this.capBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped) this.retainedBytes -= dropped.bytes
      this.wasTruncated = true
    }
    this.pending.push(chunk)
    if (this.immediate === null) {
      this.immediate = setImmediate(() => {
        this.immediate = null
        this.flush()
      })
    }
  }

  /** Publishes (and logs) everything appended since the last flush, synchronously. */
  flush(): void {
    if (this.immediate !== null) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.pending.length === 0) return
    const text = this.pending.join('')
    this.pending = []
    try {
      this.publish(text)
    } catch (err) {
      // Never the error itself: its message could quote the output.
      log.warn('Publishing shell command output failed', {
        name: err instanceof Error ? err.name : 'unknown'
      })
    }
    this.appendToLog(text)
  }

  /** The retained transcript (call flush() first when the pending output matters). */
  snapshot(): string {
    const text = this.chunks.map((chunk) => chunk.text).join('')
    if (!this.wasTruncated) return text
    return SHELL_COMMAND_LOG_TRUNCATED_MARKER + cutAtFirstNewline(text, SNAPSHOT_HEAD_CUT_CHARS)
  }

  /** Flushes, makes the log equal the retained transcript when it was truncated, releases the fd. */
  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    if (this.logFile !== null && this.wasTruncated) this.rewriteLog()
    this.closeFd()
  }

  private appendToLog(text: string): void {
    if (this.logFile === null) return
    try {
      if (this.fd === null) {
        this.fd = openSync(this.logFile, 'a', 0o600)
        this.fileBytes = fstatSync(this.fd).size
      }
      const bytes = Buffer.from(text, 'utf8')
      writeSync(this.fd, bytes)
      this.fileBytes += bytes.length
      if (this.fileBytes > 2 * this.capBytes) this.rewriteLog()
    } catch (err) {
      this.reportFileError(err)
    }
  }

  /** Replaces the log with the retained transcript (tmp file + rename), reopening the fd. */
  private rewriteLog(): void {
    if (this.logFile === null) return
    try {
      this.closeFd()
      const text = this.snapshot()
      writeFileSync(this.logFile + '.tmp', text, { mode: 0o600 })
      renameSync(this.logFile + '.tmp', this.logFile)
      if (!this.closed) {
        this.fd = openSync(this.logFile, 'a', 0o600)
        this.fileBytes = Buffer.byteLength(text, 'utf8')
      }
    } catch (err) {
      this.reportFileError(err)
    }
  }

  private closeFd(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      // Nothing left to release.
    }
    this.fd = null
  }

  private reportFileError(err: unknown): void {
    if (this.fileErrorLogged) return
    this.fileErrorLogged = true
    log.warn('Shell command log file write failed', {
      code: err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
    })
  }
}

/**
 * The last `capBytes` of a run's log: the whole file when it fits, otherwise the tail
 * cut at the first newline (within 64 KiB) and prefixed with the truncated marker.
 * '' when the file is missing or unreadable.
 */
export function readShellCommandLogTail(
  logFile: string,
  capBytes = SHELL_COMMAND_LOG_CAP_BYTES
): string {
  let size: number
  try {
    size = statSync(logFile).size
  } catch {
    return ''
  }
  let fd: number | null = null
  try {
    fd = openSync(logFile, 'r')
    const start = size <= capBytes ? 0 : size - capBytes
    const buffer = Buffer.allocUnsafe(size - start)
    let filled = 0
    while (filled < buffer.length) {
      const read = readSync(
        fd,
        buffer,
        filled,
        Math.min(READ_CHUNK_BYTES, buffer.length - filled),
        start + filled
      )
      if (read <= 0) break
      filled += read
    }
    const bytes = buffer.subarray(0, filled)
    if (start === 0) return bytes.toString('utf8')
    const text = utf8Tail(bytes, bytes.length)
    return SHELL_COMMAND_LOG_TRUNCATED_MARKER + cutAtFirstNewline(text, TAIL_HEAD_CUT_CHARS)
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

/** Shrinks a finished run's log to the retained tail (tmp file + rename). Never throws. */
export function trimShellCommandLog(logFile: string, capBytes = SHELL_COMMAND_LOG_CAP_BYTES): void {
  try {
    if (statSync(logFile).size <= capBytes) return
    const tail = readShellCommandLogTail(logFile, capBytes)
    writeFileSync(logFile + '.tmp', tail, { mode: 0o600 })
    renameSync(logFile + '.tmp', logFile)
  } catch (err) {
    log.warn('Trimming a shell command log failed', {
      code: err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
    })
  }
}

/** Best-effort append (the Stopped / Interrupted markers). */
export function appendToShellCommandLog(logFile: string, text: string): void {
  try {
    appendFileSync(logFile, text, { mode: 0o600 })
  } catch {
    // The transcript on disk is a convenience; the run state is what matters.
  }
}
