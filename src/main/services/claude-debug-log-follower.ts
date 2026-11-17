// Follows one Claude CLI debug log and hands every complete line to a consumer exactly once,
// in order, however the file is replaced underneath it (Code Mode live usage: PRD FR-20, FR-21,
// LF-2 to LF-5, SEC-3, SEC-6, PF-3).
//
// It owns no timer. The usage source calls `check()` when it wants the file looked at, and
// `close()` when the session ends. Everything is synchronous, bounded fs work, like the
// transcript tailers (claude-plan-followup-watcher.ts), so nothing goes through the libuv
// thread pool.
//
// What the writer does (PRD section 8): the CLI opens, appends and closes the file on every
// write, recreates the path on its next write if the file was renamed or deleted, and renames
// the file to `<path>.1` whenever its own byte counter passes 10 MiB.
//
// How nothing is lost:
//   - The follower keeps its own read descriptor. A file that is renamed or deleted is still
//     readable through it, and its inode cannot be reused while it is open, so comparing the
//     file at the path with the descriptor is a reliable "was it replaced" test.
//   - When another file appears at the path, the old descriptor is read to its end first, and
//     only then is the new file read from offset 0. That is the whole rotation handling: the
//     CLI's rename to `.1`, a rename or a delete by anyone else, and the follower's own rotation
//     all end up there.
//   - Own rotation: once the file is at least 1 MiB and has been read to its end (and that end
//     is the end of a line), the follower renames it to `<path>.old`. Lines written between the
//     last read and the rename are in the renamed file, and are read through the descriptor.
//     Truncating instead would drop them.
//   - While nothing is at the path, the descriptor stays open. A write that had already opened
//     the old file when it was renamed still lands in it, and is read on a later check.
//   - A retired file is deleted from disk as soon as it has been read to its end (any name it
//     has in the log's directory: `.1`, `.old`, or whatever it was renamed to).
//
// Limits, by construction:
//   - Lines in a file that is truncated in place before they were read are gone: no reader can
//     recover them. Lines read before the truncation and lines written after it are delivered
//     once each. A truncation is noticed by a smaller size, or, when the file has already grown
//     past the old offset again, by the bytes before the offset no longer matching. One that is
//     refilled to exactly the old size is not noticed: that would take a read of a file whose
//     size did not change.
//   - If the path is replaced twice between two checks, the file in the middle was never open
//     here and is not read. The CLI would have to pass its 10 MiB counter within one check
//     interval of another rotation.
//   - A fragment without a newline at the end of a retired file is dropped: the writer appends
//     whole lines, so the rest of it can only have gone to the same file.
//
// Nothing here logs: a line is never written anywhere, and trouble is reported to the caller as
// an event or a counter (SEC-5, SEC-6).
import * as nodeFs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Own rotation: a file at least this large that has been read to its end is retired (LF-3). */
export const DEBUG_LOG_ROTATE_BYTES = 1024 * 1024
/** A line longer than this, newline excluded, is skipped (FR-21, SEC-6). */
export const DEBUG_LOG_MAX_LINE_BYTES = 1024 * 1024
/** One check reads at most this much; a backlog continues on the next check (PF-3). */
export const DEBUG_LOG_MAX_BYTES_PER_CHECK = 256 * 1024
/** A file larger than this is deleted and reported (LF-5). */
export const DEBUG_LOG_HARD_CAP_BYTES = 32 * 1024 * 1024
/** Appended to the path for the follower's own rotation (LF-3). */
export const DEBUG_LOG_RETIRED_SUFFIX = '.old'

const READ_CHUNK_BYTES = 64 * 1024
/** How many bytes before the offset are remembered to notice a truncate-and-regrow. */
const TAIL_GUARD_BYTES = 32
const OWNER_ONLY_MODE = 0o600

// O_NOFOLLOW refuses a symbolic link at the path; O_NONBLOCK keeps an open of a FIFO from
// hanging. Neither exists on Windows, where the lstat check is the only one.
const OPEN_FLAGS =
  nodeFs.constants.O_RDONLY |
  (nodeFs.constants.O_NOFOLLOW ?? 0) |
  (nodeFs.constants.O_NONBLOCK ?? 0)

/** The fs calls the follower makes. */
export type DebugLogFollowerFs = Pick<
  typeof nodeFs,
  | 'lstatSync'
  | 'openSync'
  | 'fstatSync'
  | 'readSync'
  | 'closeSync'
  | 'fchmodSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'readdirSync'
>

export type DebugLogUnsafeFile = 'symlink' | 'not-regular-file' | 'foreign-owner'

export type DebugLogFollowerEvent =
  /**
   * The file at the path stopped being the one that was followed:
   * - `own`: the follower retired it at the rotation size;
   * - `replaced`: another file is at the path (the CLI's `.1` rotation, or a rename or delete
   *   followed by a write);
   * - `removed`: nothing is at the path (renamed or deleted, not written since);
   * - `truncated`: the same file was cut short and is read again from its start.
   */
  | { type: 'rotated'; cause: 'own' | 'replaced' | 'removed' | 'truncated' }
  /** The file was past the hard cap and was deleted; lines not yet read from it are lost. */
  | { type: 'degraded'; reason: 'hard-cap' }
  /** What is at the path was refused and left untouched. Reported once per offending file. */
  | { type: 'degraded'; reason: 'unsafe-file'; detail: DebugLogUnsafeFile }

export interface DebugLogFollowerStats {
  /** Calls to `check()` that ran, plus the final read of `close()`. */
  checks: number
  /** Read calls made on the file. */
  reads: number
  /** Bytes of log taken from the file. */
  bytesRead: number
  linesDelivered: number
  /** Lines longer than the limit, skipped. */
  oversizedLinesSkipped: number
  /** Fragments without a newline, dropped when their file was retired, truncated or closed. */
  partialLinesDropped: number
  /** `rotated` events. */
  rotations: number
  /** Times the consumer threw. The line counts as delivered and is not offered again. */
  consumerErrors: number
  /** fs calls that failed unexpectedly. */
  errors: number
}

export interface DebugLogFollowerOptions {
  /** The log to follow. */
  path: string
  /**
   * Receives each complete line, without its line ending. Must not keep, log or forward the
   * line itself (SEC-5).
   */
  onLine: (line: string) => void
  /** Rotation and degraded signals. Carries no log content. */
  onEvent?: (event: DebugLogFollowerEvent) => void
  /** Defaults to `DEBUG_LOG_ROTATE_BYTES`. */
  rotateBytes?: number
  /** Defaults to `DEBUG_LOG_MAX_LINE_BYTES`. */
  maxLineBytes?: number
  /** Defaults to `DEBUG_LOG_MAX_BYTES_PER_CHECK`. */
  maxBytesPerCheck?: number
  /** Defaults to `DEBUG_LOG_HARD_CAP_BYTES`. */
  hardCapBytes?: number
  /** Injectable for tests. */
  fs?: DebugLogFollowerFs
  /** Injectable for tests. `null` (Windows) skips the owner check and the chmod. */
  getUid?: () => number | null
}

interface FollowedFile {
  fd: number
  dev: bigint
  ino: bigint
  /** Bytes taken from the file so far: delivered, held as a partial line, or skipped. */
  offset: number
  /** Copy of the bytes just before `offset`, compared again before the next read. */
  guard: Buffer
  /** The path no longer names this file. The rotation was reported when that was noticed. */
  detached: boolean
  /** Its other names in the log's directory were deleted after it was read to its end. */
  namesRemoved: boolean
  /** Size at which renaming it for own rotation failed; not tried again until it grows. */
  rotateFailedAtSize: number
}

function sameFile(stats: BigIntStats, file: FollowedFile): boolean {
  return stats.ino === file.ino && stats.dev === file.dev
}

/** Identifies what was refused, so that it is reported once and not on every check. */
function identityKey(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.uid}:${stats.mode}`
}

function nextGuard(previous: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= TAIL_GUARD_BYTES) {
    return Buffer.from(chunk.subarray(chunk.length - TAIL_GUARD_BYTES))
  }
  const joined = Buffer.concat([previous, chunk])
  return joined.subarray(Math.max(0, joined.length - TAIL_GUARD_BYTES))
}

export class DebugLogFollower {
  private readonly path: string
  private readonly dir: string
  private readonly name: string
  private readonly onLine: (line: string) => void
  private readonly onEvent: ((event: DebugLogFollowerEvent) => void) | undefined
  private readonly fs: DebugLogFollowerFs
  private readonly uid: number | null
  private readonly rotateBytes: number
  private readonly maxLineBytes: number
  private readonly maxBytesPerCheck: number
  private readonly hardCapBytes: number

  private file: FollowedFile | null = null
  /** What was last refused at the path (or could not be deleted); skipped until it changes. */
  private reportedKey: string | null = null
  /** Pieces of the line whose newline has not been read yet. */
  private partial: Buffer[] = []
  private partialBytes = 0
  /** Inside a line that is over the limit: bytes are dropped up to its newline. */
  private skippingLine = false
  private scratch: Buffer | null = null
  /** Bytes this check may still read. */
  private budget = 0
  private running = false
  private closed = false
  private closeRequested = false

  private readonly counters: DebugLogFollowerStats = {
    checks: 0,
    reads: 0,
    bytesRead: 0,
    linesDelivered: 0,
    oversizedLinesSkipped: 0,
    partialLinesDropped: 0,
    rotations: 0,
    consumerErrors: 0,
    errors: 0
  }

  constructor(options: DebugLogFollowerOptions) {
    this.path = options.path
    this.dir = dirname(options.path)
    this.name = basename(options.path)
    this.onLine = options.onLine
    this.onEvent = options.onEvent
    this.fs = options.fs ?? nodeFs
    this.uid = options.getUid ? options.getUid() : (process.getuid?.() ?? null)
    this.rotateBytes = options.rotateBytes ?? DEBUG_LOG_ROTATE_BYTES
    this.maxLineBytes = options.maxLineBytes ?? DEBUG_LOG_MAX_LINE_BYTES
    this.maxBytesPerCheck = options.maxBytesPerCheck ?? DEBUG_LOG_MAX_BYTES_PER_CHECK
    this.hardCapBytes = options.hardCapBytes ?? DEBUG_LOG_HARD_CAP_BYTES
  }

  /**
   * Look at the file now and deliver what is new, up to the per-check bound. An unchanged file
   * costs one lstat and no read. Never throws.
   */
  check(): void {
    this.run(this.maxBytesPerCheck, false)
  }

  /**
   * One final read, without the per-check bound, then the descriptor is released. Lines written
   * just before this call are delivered by it. Later calls to `check()` do nothing.
   */
  close(): void {
    if (this.closed) return
    if (this.running) {
      // Called by the consumer from inside a check: finish that check first.
      this.closeRequested = true
      return
    }
    this.run(Number.POSITIVE_INFINITY, true)
    this.closed = true
    this.dropPartial()
    if (this.file) {
      this.closeFd(this.file.fd)
      this.file = null
    }
    this.scratch = null
  }

  stats(): DebugLogFollowerStats {
    return { ...this.counters }
  }

  private run(budget: number, final: boolean): void {
    if (this.closed || this.running) return
    this.running = true
    this.budget = budget
    this.counters.checks += 1
    try {
      this.step(final)
    } catch {
      this.counters.errors += 1
    } finally {
      this.running = false
    }
    if (this.closeRequested) {
      this.closeRequested = false
      this.close()
    }
  }

  private step(final: boolean): void {
    const atPath = this.lstat(this.path)
    let file = this.file
    if (file && atPath && !sameFile(atPath, file)) {
      // Another file is at the path. The old one is finished first, to keep the order.
      if (!this.finishRetired(file)) return
      file = null
    }
    if (file) {
      this.follow(file, atPath, final)
      return
    }
    if (!atPath) {
      this.reportedKey = null
      return
    }
    const opened = this.open(atPath)
    if (opened) this.follow(opened, atPath, final)
  }

  /**
   * Reads what is new in the followed file. `atPath` is the lstat of the path when the path
   * still names this file, and null when nothing is at the path.
   */
  private follow(file: FollowedFile, atPath: BigIntStats | null, final: boolean): void {
    let size: number
    if (atPath) {
      file.detached = false
      size = Number(atPath.size)
    } else {
      // Renamed or deleted, and not written since. A write that was already under way still
      // lands in this file, so it stays open until another file shows up at the path.
      const open = this.fstatSize(file)
      if (open === null) {
        this.release(file)
        return
      }
      size = open
      if (!file.detached) {
        file.detached = true
        file.namesRemoved = false
        this.emit({ type: 'rotated', cause: 'removed' })
      }
    }

    if (size > this.hardCapBytes) {
      this.dropOverCap(file, atPath)
      return
    }
    if (size < file.offset) this.restart(file)
    if (size > file.offset && !this.read(file, size)) return
    if (file.offset < size) return // The rest waits for the next check.

    if (file.detached) {
      if (!file.namesRemoved) {
        this.removeNames(file)
        file.namesRemoved = true
      }
      return
    }
    // Not in the middle of a line: its other half would go to the file the CLI creates next.
    const midLine = this.partialBytes > 0 || this.skippingLine
    if (!final && !midLine && size >= this.rotateBytes && size > file.rotateFailedAtSize) {
      this.rotate(file, size)
    }
  }

  /**
   * Own rotation. The file stays open: what is appended to it between the last read and the
   * rename, or by a write that had already opened it, is read on the following checks.
   */
  private rotate(file: FollowedFile, size: number): void {
    // The check started with an lstat; make sure the file was not replaced since, or the
    // rename would move a file that has never been read.
    const now = this.lstat(this.path)
    if (!now || !sameFile(now, file)) return
    try {
      this.fs.renameSync(this.path, this.path + DEBUG_LOG_RETIRED_SUFFIX)
    } catch {
      this.counters.errors += 1
      file.rotateFailedAtSize = size
      return
    }
    file.detached = true
    file.namesRemoved = false
    this.emit({ type: 'rotated', cause: 'own' })
  }

  /**
   * Another file is at the path: read the old one to its end, then let go of it and delete it.
   * Returns false while a backlog remains, so that the new file is not read ahead of it.
   */
  private finishRetired(file: FollowedFile): boolean {
    const size = this.fstatSize(file)
    if (size === null) {
      this.release(file)
      return true
    }
    if (size > this.hardCapBytes) {
      this.release(file)
      this.emit({ type: 'degraded', reason: 'hard-cap' })
      return true
    }
    if (size < file.offset) this.restart(file)
    if (size > file.offset && !this.read(file, size)) {
      // Unreadable: waiting for it would hold up the new file for good.
      this.release(file)
      return true
    }
    if (file.offset < size) return false
    const reported = file.detached
    this.release(file)
    if (!reported) this.emit({ type: 'rotated', cause: 'replaced' })
    return true
  }

  /** Opens what is at the path, if it is safe to read. */
  private open(atPath: BigIntStats): FollowedFile | null {
    const key = identityKey(atPath)
    if (key === this.reportedKey) return null
    const unsafe = this.unsafeReason(atPath)
    if (unsafe) return this.refuse(key, unsafe)

    let fd: number
    try {
      fd = this.fs.openSync(this.path, OPEN_FLAGS)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Swapped for a symbolic link after the lstat.
      if (code === 'ELOOP' || code === 'EMLINK') return this.refuse(key, 'symlink')
      if (code !== 'ENOENT') this.counters.errors += 1
      return null
    }

    // The descriptor is what gets read, so it is what gets checked.
    let opened: BigIntStats
    try {
      opened = this.fs.fstatSync(fd, { bigint: true })
    } catch {
      this.counters.errors += 1
      this.closeFd(fd)
      return null
    }
    const unsafeOpened = this.unsafeReason(opened)
    if (unsafeOpened) {
      this.closeFd(fd)
      return this.refuse(identityKey(opened), unsafeOpened)
    }
    if (opened.ino !== atPath.ino || opened.dev !== atPath.dev) {
      // Replaced between the lstat and the open. The next check starts over.
      this.closeFd(fd)
      return null
    }

    // The CLI recreates the file with the umask default (SEC-3).
    if (this.uid !== null && (Number(opened.mode) & 0o077) !== 0) {
      try {
        this.fs.fchmodSync(fd, OWNER_ONLY_MODE)
      } catch {
        this.counters.errors += 1
      }
    }

    this.reportedKey = null
    this.file = {
      fd,
      dev: opened.dev,
      ino: opened.ino,
      offset: 0,
      guard: Buffer.alloc(0),
      detached: false,
      namesRemoved: false,
      rotateFailedAtSize: 0
    }
    return this.file
  }

  private unsafeReason(stats: BigIntStats): DebugLogUnsafeFile | null {
    if (stats.isSymbolicLink()) return 'symlink'
    if (!stats.isFile()) return 'not-regular-file'
    if (this.uid !== null && Number(stats.uid) !== this.uid) return 'foreign-owner'
    return null
  }

  private refuse(key: string, detail: DebugLogUnsafeFile): null {
    this.reportedKey = key
    this.emit({ type: 'degraded', reason: 'unsafe-file', detail })
    return null
  }

  /** Past the hard cap: delete the file and let go of it. What was not read yet is lost. */
  private dropOverCap(file: FollowedFile, atPath: BigIntStats | null): void {
    if (atPath) {
      try {
        this.fs.unlinkSync(this.path)
      } catch {
        this.counters.errors += 1
        // Could not be deleted: do not open and report it again on every check.
        this.reportedKey = identityKey(atPath)
      }
    }
    this.release(file)
    this.emit({ type: 'degraded', reason: 'hard-cap' })
  }

  /**
   * Reads from the offset up to `size`, within the budget of this check. Returns false when a
   * read failed.
   */
  private read(file: FollowedFile, size: number): boolean {
    const scratch = (this.scratch ??= Buffer.allocUnsafe(TAIL_GUARD_BYTES + READ_CHUNK_BYTES))
    // The first read of a check starts a few bytes early, to compare them with what was there
    // last time. They differ when the file was truncated and has grown past the offset again.
    let verify = file.guard.length
    while (file.offset < size && this.budget > 0) {
      const want = Math.min(size - file.offset, this.budget, READ_CHUNK_BYTES)
      let count: number
      try {
        count = this.fs.readSync(file.fd, scratch, 0, verify + want, file.offset - verify)
      } catch {
        this.counters.errors += 1
        return false
      }
      this.counters.reads += 1
      if (verify > 0 && (count < verify || !scratch.subarray(0, verify).equals(file.guard))) {
        this.restart(file)
        verify = 0
        continue
      }
      const got = count - verify
      if (got <= 0) break // Shrank since the lstat; the next check sorts it out.
      const chunk = scratch.subarray(verify, count)
      verify = 0
      file.offset += got
      file.guard = nextGuard(file.guard, chunk)
      this.budget -= got
      this.counters.bytesRead += got
      this.consume(chunk)
    }
    return true
  }

  /** The file was truncated in place: read it again from its start. */
  private restart(file: FollowedFile): void {
    file.offset = 0
    file.guard = Buffer.alloc(0)
    file.rotateFailedAtSize = 0
    this.dropPartial()
    this.emit({ type: 'rotated', cause: 'truncated' })
  }

  /** Splits on the newline byte, so a character cut by a read boundary is never decoded in halves. */
  private consume(chunk: Buffer): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline === -1) {
        this.carry(chunk.subarray(start))
        return
      }
      this.endLine(chunk.subarray(start, newline))
      start = newline + 1
    }
  }

  /** Bytes of a line whose newline has not been read yet. `piece` is copied: the buffer is reused. */
  private carry(piece: Buffer): void {
    if (this.skippingLine) return
    if (this.partialBytes + piece.length > this.maxLineBytes) {
      // Over the limit before its newline: stop holding it and skip the rest as it arrives.
      this.partial = []
      this.partialBytes = 0
      this.skippingLine = true
      this.counters.oversizedLinesSkipped += 1
      return
    }
    this.partial.push(Buffer.from(piece))
    this.partialBytes += piece.length
  }

  private endLine(rest: Buffer): void {
    if (this.skippingLine) {
      this.skippingLine = false
      return
    }
    const length = this.partialBytes + rest.length
    const pieces = this.partial
    if (this.partialBytes > 0) {
      this.partial = []
      this.partialBytes = 0
    }
    if (length > this.maxLineBytes) {
      this.counters.oversizedLinesSkipped += 1
      return
    }
    const line = pieces.length > 0 ? Buffer.concat([...pieces, rest], length) : rest
    const end = length > 0 && line[length - 1] === 0x0d ? length - 1 : length
    const text = line.toString('utf8', 0, end)
    this.counters.linesDelivered += 1
    try {
      this.onLine(text)
    } catch {
      // Counted, not recorded: the message of a parse error can quote the line (SEC-6).
      this.counters.consumerErrors += 1
    }
  }

  private dropPartial(): void {
    if (this.partialBytes > 0) this.counters.partialLinesDropped += 1
    this.partial = []
    this.partialBytes = 0
    this.skippingLine = false
  }

  /** Lets go of a file the path no longer names, and deletes it from disk. */
  private release(file: FollowedFile): void {
    this.dropPartial()
    this.closeFd(file.fd)
    if (!file.namesRemoved) {
      this.removeNames(file)
      file.namesRemoved = true
    }
    if (this.file === file) this.file = null
  }

  /**
   * Deletes the retired file under whatever name it has in the log's directory (`.1`, `.old`,
   * or the name someone renamed it to). Only entries that are that very file are touched, and
   * never the log path itself.
   */
  private removeNames(file: FollowedFile): void {
    let names: string[]
    try {
      names = this.fs.readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === this.name) continue
      const candidate = join(this.dir, name)
      const stats = this.lstat(candidate)
      if (!stats || !sameFile(stats, file)) continue
      try {
        this.fs.unlinkSync(candidate)
      } catch {
        this.counters.errors += 1
      }
    }
  }

  private lstat(path: string): BigIntStats | null {
    try {
      return this.fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }) ?? null
    } catch {
      this.counters.errors += 1
      return null
    }
  }

  private fstatSize(file: FollowedFile): number | null {
    try {
      return Number(this.fs.fstatSync(file.fd, { bigint: true }).size)
    } catch {
      this.counters.errors += 1
      return null
    }
  }

  private closeFd(fd: number): void {
    try {
      this.fs.closeSync(fd)
    } catch {
      this.counters.errors += 1
    }
  }

  private emit(event: DebugLogFollowerEvent): void {
    if (event.type === 'rotated') this.counters.rotations += 1
    try {
      this.onEvent?.(event)
    } catch {
      this.counters.consumerErrors += 1
    }
  }
}
