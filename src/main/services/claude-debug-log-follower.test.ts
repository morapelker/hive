import * as fs from 'node:fs'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEBUG_LOG_HARD_CAP_BYTES,
  DEBUG_LOG_MAX_BYTES_PER_CHECK,
  DEBUG_LOG_MAX_LINE_BYTES,
  DEBUG_LOG_ROTATE_BYTES,
  DebugLogFollower,
  type DebugLogFollowerEvent,
  type DebugLogFollowerFs,
  type DebugLogFollowerOptions
} from './claude-debug-log-follower'

const posixOnly = process.platform === 'win32' ? it.skip : it

/** For the tests that write megabytes: the default 5 s is tight on a busy machine. */
const LARGE_FILE_TIMEOUT_MS = 30_000

const FS_CALLS = [
  'lstatSync',
  'openSync',
  'fstatSync',
  'readSync',
  'closeSync',
  'fchmodSync',
  'renameSync',
  'unlinkSync',
  'readdirSync'
] as const

type FsCall = (typeof FS_CALLS)[number]

/** The real fs, with every call counted and any call replaceable. */
function instrumentedFs(overrides: Partial<DebugLogFollowerFs> = {}): {
  fs: DebugLogFollowerFs
  calls: Record<FsCall, number>
} {
  const calls = Object.fromEntries(FS_CALLS.map((name) => [name, 0])) as Record<FsCall, number>
  const facade: Record<string, unknown> = {}
  for (const name of FS_CALLS) {
    const target = (overrides[name] ?? fs[name]) as (...args: unknown[]) => unknown
    facade[name] = (...args: unknown[]): unknown => {
      calls[name] += 1
      return target(...args)
    }
  }
  return { fs: facade as unknown as DebugLogFollowerFs, calls }
}

function entry(index: number): string {
  return `2026-11-17T10:00:00.000Z [DEBUG] entry ${index}`
}

/** Deterministic random numbers in [0, 1), so that a failing sequence can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

describe('DebugLogFollower', () => {
  let dir: string
  let logPath: string
  /** Every complete line the writer has written, in order. */
  let written: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'debug-log-follower-'))
    logPath = join(dir, 'usage.log')
    written = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function follow(options: Partial<DebugLogFollowerOptions> = {}): {
    follower: DebugLogFollower
    lines: string[]
    events: DebugLogFollowerEvent[]
  } {
    const lines: string[] = []
    const events: DebugLogFollowerEvent[] = []
    const follower = new DebugLogFollower({
      path: logPath,
      onLine: (line) => lines.push(line),
      onEvent: (event) => events.push(event),
      ...options
    })
    return { follower, lines, events }
  }

  /** The CLI's way of writing: open, append, close on every write; a missing file is recreated. */
  function append(text: string): void {
    appendFileSync(logPath, text)
  }

  function write(count: number, pad = 0): void {
    for (let i = 0; i < count; i++) {
      const line = entry(written.length) + (pad > 0 ? ' ' + 'x'.repeat(pad) : '')
      written.push(line)
      append(line + '\n')
    }
  }

  /** Many lines in a single append, for tests that only need a large file. */
  function writeAtOnce(count: number, pad: number): void {
    let text = ''
    for (let i = 0; i < count; i++) {
      const line = entry(written.length) + ' ' + 'x'.repeat(pad)
      written.push(line)
      text += line + '\n'
    }
    append(text)
  }

  describe('following a growing file', () => {
    it('delivers lines appended across many checks once each, in order', () => {
      const { follower, lines } = follow()
      for (let round = 0; round < 25; round++) {
        write(round % 4)
        follower.check()
        follower.check()
        expect(lines).toEqual(written)
      }
      expect(follower.stats().linesDelivered).toBe(written.length)
    })

    it('waits for the rest of a line that was split across two writes', () => {
      const { follower, lines } = follow()
      write(1)
      append('2026-11-17T10:00:01.000Z [DEBUG] first ha')
      follower.check()
      expect(lines).toEqual(written)

      follower.check()
      expect(lines).toEqual(written)

      append('lf, second half\n')
      follower.check()
      expect(lines).toEqual([
        ...written,
        '2026-11-17T10:00:01.000Z [DEBUG] first half, second half'
      ])
    })

    it('never decodes a character in halves when a write boundary cuts it', () => {
      const { follower, lines } = follow()
      const bytes = Buffer.from('prix: 12 € · ok ✓\n', 'utf8')
      const cut = bytes.indexOf(0xe2) + 1
      appendFileSync(logPath, bytes.subarray(0, cut))
      follower.check()
      appendFileSync(logPath, bytes.subarray(cut))
      follower.check()
      expect(lines).toEqual(['prix: 12 € · ok ✓'])
    })

    it('strips a carriage return before the newline and keeps empty lines', () => {
      const { follower, lines } = follow()
      append('one\r\n\ntwo\n')
      follower.check()
      expect(lines).toEqual(['one', '', 'two'])
    })

    it('stays quiet while the file does not exist, then follows it from its start', () => {
      const { follower, lines, events } = follow()
      follower.check()
      follower.check()
      expect(events).toEqual([])
      expect(follower.stats().errors).toBe(0)

      write(3)
      follower.check()
      expect(lines).toEqual(written)
    })

    it(
      'reads a bounded amount per check and continues on the next ones',
      () => {
        const { follower, lines } = follow()
        writeAtOnce(600, 1024)
        const total = statSync(logPath).size
        expect(total).toBeGreaterThan(2 * DEBUG_LOG_MAX_BYTES_PER_CHECK)

        follower.check()
        expect(follower.stats().bytesRead).toBe(DEBUG_LOG_MAX_BYTES_PER_CHECK)
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.length).toBeLessThan(written.length)

        follower.check()
        expect(follower.stats().bytesRead).toBe(2 * DEBUG_LOG_MAX_BYTES_PER_CHECK)

        follower.check()
        expect(follower.stats().bytesRead).toBe(total)
        expect(lines).toEqual(written)
      },
      LARGE_FILE_TIMEOUT_MS
    )

    it('keeps delivering after the consumer throws, and does not offer the line again', () => {
      const lines: string[] = []
      const follower = new DebugLogFollower({
        path: logPath,
        onLine: (line) => {
          lines.push(line)
          if (line === entry(1)) throw new Error('consumer failed')
        }
      })
      write(3)
      follower.check()
      write(1)
      follower.check()
      expect(lines).toEqual(written)
      expect(follower.stats().consumerErrors).toBe(1)
    })
  })

  describe('no work when nothing changed', () => {
    it('makes one lstat and no read on an unchanged file', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines } = follow({ fs: facade })
      write(3)
      follower.check()
      expect(lines).toEqual(written)
      expect(calls.readSync).toBeGreaterThan(0)

      const before = { ...calls }
      const readsBefore = follower.stats().reads
      follower.check()
      follower.check()
      follower.check()
      expect(calls).toEqual({ ...before, lstatSync: before.lstatSync + 3 })
      expect(follower.stats().reads).toBe(readsBefore)
      expect(lines).toEqual(written)
    })

    it('does not read an unchanged file that holds half a line', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines } = follow({ fs: facade })
      append('half a li')
      follower.check()
      const reads = calls.readSync
      follower.check()
      follower.check()
      expect(calls.readSync).toBe(reads)
      expect(lines).toEqual([])
    })

    it('does not read while the file is missing or empty', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower } = follow({ fs: facade })
      follower.check()
      writeFileSync(logPath, '', { mode: 0o600 })
      follower.check()
      follower.check()
      expect(calls.readSync).toBe(0)
    })
  })

  describe('a file replaced underneath it, while the writer keeps appending', () => {
    const replacements: { name: string; replace: () => void }[] = [
      {
        name: 'rename then recreate',
        replace: () => renameSync(logPath, join(dir, 'moved-aside.log'))
      },
      { name: 'delete then recreate', replace: () => unlinkSync(logPath) },
      { name: 'rename to the .1 sibling', replace: () => renameSync(logPath, logPath + '.1') }
    ]

    beforeEach(() => {
      // What the session directory holds next to the log.
      writeFileSync(join(dir, 'env.sh'), 'unset ANTHROPIC_LOG\n', { mode: 0o600 })
      symlinkSync(logPath, join(dir, 'latest'))
    })

    for (const { name, replace } of replacements) {
      it(`${name}: loses and duplicates nothing when the writer is first`, () => {
        const { follower, lines, events } = follow()
        write(5)
        follower.check()
        write(3) // Not read yet when the file goes away.
        replace()
        write(4) // The writer recreates the path.
        follower.check()
        expect(lines).toEqual(written)
        expect(readdirSync(dir).sort()).toEqual(['env.sh', 'latest', 'usage.log'])

        write(2)
        follower.check()
        expect(lines).toEqual(written)
        expect(events).toEqual([{ type: 'rotated', cause: 'replaced' }])
      })

      it(`${name}: loses and duplicates nothing when a check sees the empty path first`, () => {
        const { follower, lines, events } = follow()
        write(5)
        follower.check()
        write(3)
        replace()
        follower.check()
        expect(lines).toEqual(written)
        // The retired file is gone from disk as soon as it has been read to its end.
        expect(readdirSync(dir).sort()).toEqual(['env.sh', 'latest'])

        follower.check()
        write(4)
        follower.check()
        write(2)
        follower.check()
        expect(lines).toEqual(written)
        expect(readdirSync(dir).sort()).toEqual(['env.sh', 'latest', 'usage.log'])
        expect(events).toEqual([{ type: 'rotated', cause: 'removed' }])
      })

      it(`${name}: repeated many times in a row`, () => {
        const { follower, lines } = follow()
        for (let round = 0; round < 20; round++) {
          write(1 + (round % 3))
          if (round % 2 === 0) follower.check()
          write(2)
          replace()
          if (round % 3 === 0) follower.check()
          write(1 + (round % 2))
          follower.check()
          expect(lines).toEqual(written)
        }
        expect(readdirSync(dir).sort()).toEqual(['env.sh', 'latest', 'usage.log'])
      })
    }

    it('truncate in place: lines read before it and written after it arrive once each', () => {
      const { follower, lines, events } = follow()
      write(5)
      follower.check()
      truncateSync(logPath, 0)
      write(3) // Shorter than what was there: noticed by the size.
      follower.check()
      write(2)
      follower.check()
      expect(lines).toEqual(written)
      expect(events).toEqual([{ type: 'rotated', cause: 'truncated' }])
    })

    it('truncate in place: noticed even when the file has already grown past the old offset', () => {
      const { follower, lines, events } = follow()
      write(5)
      follower.check()
      truncateSync(logPath, 0)
      write(9)
      expect(statSync(logPath).size).toBeGreaterThan(5 * (entry(0).length + 1))
      follower.check()
      write(2)
      follower.check()
      expect(lines).toEqual(written)
      expect(events).toEqual([{ type: 'rotated', cause: 'truncated' }])
    })

    it('truncate in place, repeatedly, between appends', () => {
      const { follower, lines } = follow()
      for (let round = 0; round < 20; round++) {
        write(1 + (round % 4))
        follower.check()
        const sizeBefore = statSync(logPath).size
        truncateSync(logPath, 0)
        write(round % 5)
        // A file cut and refilled to the very same size cannot be told apart without reading
        // it, which an unchanged size must not cause.
        if (statSync(logPath).size === sizeBefore) write(1)
        follower.check()
        expect(lines).toEqual(written)
      }
    })

    it('finishes a backlog in the old file before reading the new one', () => {
      const { follower, lines } = follow({ maxBytesPerCheck: 100 })
      write(20)
      follower.check()
      expect(lines.length).toBeLessThan(5)
      renameSync(logPath, logPath + '.1')
      write(20)
      let checks = 0
      while (lines.length < written.length && checks < 200) {
        follower.check()
        checks += 1
        // Whatever has arrived so far is a prefix: nothing from the new file jumped ahead.
        expect(lines).toEqual(written.slice(0, lines.length))
      }
      expect(lines).toEqual(written)
      expect(checks).toBeGreaterThan(10)
      expect(existsSync(logPath + '.1')).toBe(false)
    })

    it('drops a fragment without a newline that a retired file ends with', () => {
      const { follower, lines } = follow()
      write(2)
      append('never finished')
      follower.check()
      renameSync(logPath, logPath + '.1')
      write(2)
      follower.check()
      expect(lines).toEqual(written)
      expect(follower.stats().partialLinesDropped).toBe(1)
    })
  })

  describe('own rotation', () => {
    it(
      'retires the file at 1 MiB without losing or repeating a line',
      () => {
        const { follower, lines, events } = follow()
        let largestSeen = 0
        // About 2.6 MiB in 4 KiB lines, one write per line, checked every 10 lines.
        for (let round = 0; round < 65; round++) {
          write(10, 4096)
          largestSeen = Math.max(largestSeen, statSync(logPath).size)
          follower.check()
          expect(lines.length).toBe(written.length)
        }
        follower.check()
        expect(lines).toEqual(written)

        const own = events.filter((event) => event.type === 'rotated' && event.cause === 'own')
        expect(own.length).toBe(2)
        expect(events.length).toBe(2)
        // The file never got far past the rotation size, and no retired file is left behind.
        expect(largestSeen).toBeLessThan(DEBUG_LOG_ROTATE_BYTES + 64 * 1024)
        expect(readdirSync(dir)).toEqual(['usage.log'])
        expect(statSync(logPath).size).toBeLessThan(DEBUG_LOG_ROTATE_BYTES)
      },
      LARGE_FILE_TIMEOUT_MS
    )

    it('leaves a file under the rotation size alone', () => {
      const { follower, events } = follow({ rotateBytes: 4096 })
      write(10)
      follower.check()
      follower.check()
      expect(events).toEqual([])
      expect(readdirSync(dir)).toEqual(['usage.log'])
    })

    it('renames to the .old sibling, then deletes it once read to its end', () => {
      const { follower, lines, events } = follow({ rotateBytes: 256 })
      write(10)
      const inode = statSync(logPath).ino
      follower.check()
      expect(events).toEqual([{ type: 'rotated', cause: 'own' }])
      expect(readdirSync(dir)).toEqual(['usage.log.old'])
      expect(statSync(logPath + '.old').ino).toBe(inode)

      follower.check()
      expect(readdirSync(dir)).toEqual([])

      write(3)
      follower.check()
      expect(lines).toEqual(written)
      expect(readdirSync(dir)).toEqual(['usage.log'])
      expect(events).toEqual([{ type: 'rotated', cause: 'own' }])
    })

    it('keeps the lines of writes that land around the rename', () => {
      let inFlight: number | null = null
      const { fs: facade } = instrumentedFs({
        renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
          // After the follower's last read, before the rename.
          write(1)
          // A write that has opened the file but not written yet.
          inFlight = openSync(logPath, 'a')
          renameSync(from, to)
        }) as typeof fs.renameSync
      })
      const { follower, lines, events } = follow({ fs: facade, rotateBytes: 256 })
      write(10)
      follower.check()
      expect(events).toEqual([{ type: 'rotated', cause: 'own' }])
      expect(inFlight).not.toBeNull()

      const late = entry(written.length)
      written.push(late)
      writeSync(inFlight!, late + '\n')
      closeSync(inFlight!)
      write(2) // The next write recreates the path.

      follower.check()
      expect(lines).toEqual(written)
      expect(readdirSync(dir)).toEqual(['usage.log'])
    })

    it('still reads a write that lands in the retired file after it was deleted from disk', () => {
      let inFlight: number | null = null
      const { fs: facade } = instrumentedFs({
        renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
          inFlight = openSync(logPath, 'a')
          renameSync(from, to)
        }) as typeof fs.renameSync
      })
      const { follower, lines } = follow({ fs: facade, rotateBytes: 256 })
      write(10)
      follower.check()
      follower.check()
      expect(readdirSync(dir)).toEqual([])

      const late = entry(written.length)
      written.push(late)
      writeSync(inFlight!, late + '\n')
      closeSync(inFlight!)
      follower.check()
      expect(lines).toEqual(written)

      write(2)
      follower.check()
      expect(lines).toEqual(written)
      expect(readdirSync(dir)).toEqual(['usage.log'])
    })

    it('does not rotate in the middle of a line', () => {
      const { follower, lines, events } = follow({ rotateBytes: 256 })
      write(10)
      const half = entry(written.length)
      append(half.slice(0, 12))
      follower.check()
      follower.check()
      expect(events).toEqual([])

      written.push(half)
      append(half.slice(12) + '\n')
      follower.check()
      expect(lines).toEqual(written)
      expect(events).toEqual([{ type: 'rotated', cause: 'own' }])
    })

    it('does not retry a failed rename until the file has grown', () => {
      let renames = 0
      const { fs: facade } = instrumentedFs({
        renameSync: (() => {
          renames += 1
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }) as typeof fs.renameSync
      })
      const { follower, lines, events } = follow({ fs: facade, rotateBytes: 256 })
      write(10)
      follower.check()
      follower.check()
      follower.check()
      expect(renames).toBe(1)
      expect(events).toEqual([])

      write(1)
      follower.check()
      expect(renames).toBe(2)
      expect(lines).toEqual(written)
    })
  })

  describe('random interleavings', () => {
    // Appends, half lines, checks, renames, deletes, truncations and the follower's own
    // rotation in a random order, with a small read bound so that hand-overs span checks.
    //
    // Two things no reader can deliver are kept out of the sequence: a file is only replaced
    // while the follower has it open (a file that comes and goes between two checks was never
    // seen), and a file is only truncated right after a check that read all of it.
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
      it(`delivers every line once, in order (seed ${seed})`, () => {
        const random = seededRandom(seed)
        const pick = (count: number): number => Math.floor(random() * count)
        let rotatedDuringCheck = false
        const lines: string[] = []
        const follower = new DebugLogFollower({
          path: logPath,
          onLine: (line) => lines.push(line),
          onEvent: (event) => {
            if (event.type === 'rotated' && event.cause === 'own') rotatedDuringCheck = true
          },
          rotateBytes: 2048,
          maxBytesPerCheck: 700
        })

        let attached = false
        let appendedSinceCheck = false
        let pendingHalf: { full: string; rest: string } | null = null
        let aside = 0

        for (let step = 0; step < 600; step++) {
          const roll = random()
          if (roll < 0.4) {
            if (pendingHalf) continue
            write(1 + pick(3), pick(120))
            appendedSinceCheck = true
          } else if (roll < 0.5) {
            if (pendingHalf) {
              append(pendingHalf.rest + '\n')
              written.push(pendingHalf.full)
              pendingHalf = null
            } else {
              const full = entry(written.length) + ' split'
              const cut = 1 + pick(full.length - 1)
              append(full.slice(0, cut))
              pendingHalf = { full, rest: full.slice(cut) }
            }
            appendedSinceCheck = true
          } else if (roll < 0.85) {
            rotatedDuringCheck = false
            follower.check()
            expect(lines, `seed ${seed}, step ${step}`).toEqual(written.slice(0, lines.length))
            attached = lines.length === written.length && existsSync(logPath) && !rotatedDuringCheck
            appendedSinceCheck = false
          } else if (roll < 0.97) {
            if (!attached || pendingHalf) continue
            const kind = pick(3)
            if (kind === 0) renameSync(logPath, join(dir, `aside-${aside++}.log`))
            else if (kind === 1) renameSync(logPath, logPath + '.1')
            else unlinkSync(logPath)
            attached = false
          } else {
            if (!attached || appendedSinceCheck || pendingHalf) continue
            truncateSync(logPath, 0)
          }
        }

        if (pendingHalf) {
          append(pendingHalf.rest + '\n')
          written.push(pendingHalf.full)
        }
        follower.close()
        expect(lines, `seed ${seed}`).toEqual(written)
        expect(written.length).toBeGreaterThan(100)
        // Every retired file is gone, whatever it was renamed to.
        expect(readdirSync(dir).filter((name) => name !== 'usage.log')).toEqual([])
      })
    }
  })

  describe('oversized lines', () => {
    it(
      'skips a line over 1 MiB and delivers the lines after it',
      () => {
        const { follower, lines } = follow()
        write(2)
        follower.check()
        const piece = 'y'.repeat(300 * 1024)
        for (let i = 0; i < 4; i++) {
          append(piece)
          follower.check()
        }
        // Four bounded checks have read exactly 1 MiB of it, which is still within the limit.
        expect(follower.stats().oversizedLinesSkipped).toBe(0)
        follower.check()
        // Given up on as soon as it is over the limit, not held until its newline arrives.
        expect(follower.stats().oversizedLinesSkipped).toBe(1)
        append('the end of the long line\n')
        write(3)
        for (let i = 0; i < 8; i++) follower.check()

        expect(lines).toEqual(written)
        expect(follower.stats().oversizedLinesSkipped).toBe(1)
        expect(follower.stats().partialLinesDropped).toBe(0)
      },
      LARGE_FILE_TIMEOUT_MS
    )

    it(
      'skips an oversized line that arrives in one piece with its neighbours',
      () => {
        const { follower, lines } = follow()
        const long = 'z'.repeat(DEBUG_LOG_MAX_LINE_BYTES + 1)
        appendFileSync(logPath, `before\n${long}\nafter\n`)
        follower.close()
        expect(lines).toEqual(['before', 'after'])
        expect(follower.stats().oversizedLinesSkipped).toBe(1)
      },
      LARGE_FILE_TIMEOUT_MS
    )

    it('delivers a line of exactly the limit and skips one byte more', () => {
      const { follower, lines } = follow({ maxLineBytes: 16 })
      append('a'.repeat(16) + '\n')
      append('b'.repeat(17) + '\n')
      append('c'.repeat(16) + '\n')
      follower.check()
      expect(lines).toEqual(['a'.repeat(16), 'c'.repeat(16)])

      // The same, with the long line arriving in two writes.
      append('d'.repeat(10))
      follower.check()
      append('d'.repeat(7))
      follower.check()
      expect(follower.stats().oversizedLinesSkipped).toBe(2)
      append('\n' + 'e'.repeat(16) + '\n')
      follower.check()
      expect(lines).toEqual(['a'.repeat(16), 'c'.repeat(16), 'e'.repeat(16)])
      expect(follower.stats().oversizedLinesSkipped).toBe(2)
    })
  })

  describe('hard cap', () => {
    it('deletes a file past the cap and raises a degraded signal, without reading it', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines, events } = follow({ fs: facade })
      write(3)
      follower.check()
      const reads = calls.readSync

      truncateSync(logPath, DEBUG_LOG_HARD_CAP_BYTES + 1)
      follower.check()
      expect(existsSync(logPath)).toBe(false)
      expect(events).toEqual([{ type: 'degraded', reason: 'hard-cap' }])
      expect(calls.readSync).toBe(reads)

      follower.check()
      expect(events.length).toBe(1)

      // The CLI recreates the path on its next write, and following resumes.
      write(2)
      follower.check()
      expect(lines).toEqual(written)
    })

    it('applies to a file that is already too large when first seen', () => {
      const { follower, lines, events } = follow()
      writeFileSync(logPath, '')
      truncateSync(logPath, DEBUG_LOG_HARD_CAP_BYTES + 1)
      follower.check()
      expect(existsSync(logPath)).toBe(false)
      expect(events).toEqual([{ type: 'degraded', reason: 'hard-cap' }])
      expect(lines).toEqual([])
    })

    it('leaves a file of exactly the cap alone', () => {
      const { follower, events } = follow({ hardCapBytes: 64, rotateBytes: 1024 })
      append('x'.repeat(63) + '\n')
      follower.check()
      expect(existsSync(logPath)).toBe(true)
      expect(events).toEqual([])
    })

    it('deletes a renamed file that grew past the cap', () => {
      const { follower, events } = follow({ hardCapBytes: 512, rotateBytes: 4096 })
      write(2)
      follower.check()
      renameSync(logPath, logPath + '.1')
      truncateSync(logPath + '.1', 513)
      follower.check()
      expect(readdirSync(dir)).toEqual([])
      expect(events).toEqual([
        { type: 'rotated', cause: 'removed' },
        { type: 'degraded', reason: 'hard-cap' }
      ])
    })
  })

  describe('unsafe files', () => {
    posixOnly('refuses a symbolic link at the path and reports it once', () => {
      const target = join(dir, 'elsewhere.log')
      writeFileSync(target, 'not for the follower\n')
      symlinkSync(target, logPath)
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines, events } = follow({ fs: facade })

      follower.check()
      follower.check()
      follower.check()
      expect(lines).toEqual([])
      expect(events).toEqual([{ type: 'degraded', reason: 'unsafe-file', detail: 'symlink' }])
      expect(calls.openSync).toBe(0)
      expect(calls.readSync).toBe(0)
      expect(lstatSync(logPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('not for the follower\n')
    })

    posixOnly('refuses a link that is swapped in between the lstat and the open', () => {
      const target = join(dir, 'elsewhere.log')
      writeFileSync(target, 'not for the follower\n')
      const { fs: facade, calls } = instrumentedFs({
        openSync: ((path: fs.PathLike, flags: number) => {
          unlinkSync(logPath)
          symlinkSync(target, logPath)
          return openSync(path, flags)
        }) as typeof fs.openSync
      })
      const { follower, lines, events } = follow({ fs: facade })
      write(2)

      follower.check()
      expect(lines).toEqual([])
      expect(events).toEqual([{ type: 'degraded', reason: 'unsafe-file', detail: 'symlink' }])
      expect(calls.readSync).toBe(0)
      expect(readFileSync(target, 'utf8')).toBe('not for the follower\n')
    })

    posixOnly('refuses a file owned by someone else and reports it once', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines, events } = follow({
        fs: facade,
        getUid: () => process.getuid!() + 1
      })
      write(2)
      const content = readFileSync(logPath, 'utf8')

      follower.check()
      follower.check()
      expect(lines).toEqual([])
      expect(events).toEqual([{ type: 'degraded', reason: 'unsafe-file', detail: 'foreign-owner' }])
      expect(calls.openSync).toBe(0)
      expect(calls.readSync).toBe(0)
      expect(readFileSync(logPath, 'utf8')).toBe(content)
    })

    posixOnly('checks the owner of the opened descriptor, not only of the path', () => {
      const foreign = BigInt(process.getuid!() + 1)
      const { fs: facade, calls } = instrumentedFs({
        fstatSync: ((fd: number, options: fs.StatOptions & { bigint: true }) => {
          const stats = fs.fstatSync(fd, options)
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            uid: foreign
          })
        }) as typeof fs.fstatSync
      })
      const { follower, lines, events } = follow({ fs: facade })
      write(2)

      follower.check()
      expect(lines).toEqual([])
      expect(events).toEqual([{ type: 'degraded', reason: 'unsafe-file', detail: 'foreign-owner' }])
      expect(calls.readSync).toBe(0)
      expect(calls.closeSync).toBe(calls.openSync)
    })

    it('refuses something that is not a regular file', () => {
      mkdirSync(logPath)
      const { fs: facade, calls } = instrumentedFs()
      const { follower, events } = follow({ fs: facade })
      follower.check()
      follower.check()
      expect(events).toEqual([
        { type: 'degraded', reason: 'unsafe-file', detail: 'not-regular-file' }
      ])
      expect(calls.openSync).toBe(0)
      expect(existsSync(logPath)).toBe(true)
    })

    posixOnly('finishes the file it had, then refuses a link that replaced it', () => {
      const target = join(dir, 'elsewhere.log')
      writeFileSync(target, 'not for the follower\n')
      const { follower, lines, events } = follow()
      write(3)
      follower.check()
      write(2)
      renameSync(logPath, logPath + '.1')
      symlinkSync(target, logPath)

      follower.check()
      follower.check()
      expect(lines).toEqual(written)
      expect(events).toEqual([
        { type: 'rotated', cause: 'replaced' },
        { type: 'degraded', reason: 'unsafe-file', detail: 'symlink' }
      ])

      // Once a real log is back at the path, it is followed again.
      unlinkSync(logPath)
      write(2)
      follower.check()
      expect(lines).toEqual(written)
    })
  })

  describe('permissions', () => {
    posixOnly('restricts a newly created log to its owner', () => {
      const { follower, lines } = follow()
      write(1)
      chmodSync(logPath, 0o644)
      follower.check()
      expect(statSync(logPath).mode & 0o777).toBe(0o600)

      // Recreated by the CLI after a rotation, with the umask default.
      renameSync(logPath, logPath + '.1')
      write(1)
      chmodSync(logPath, 0o644)
      follower.check()
      expect(statSync(logPath).mode & 0o777).toBe(0o600)
      expect(lines).toEqual(written)
    })

    posixOnly('does not chmod a log that is already restricted', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines } = follow({ fs: facade })
      writeFileSync(logPath, '', { mode: 0o600 })
      chmodSync(logPath, 0o600)
      write(2)
      follower.check()
      expect(lines).toEqual(written)
      expect(calls.fchmodSync).toBe(0)
    })
  })

  describe('close', () => {
    it(
      'delivers what was written just before it, without the per-check bound',
      () => {
        const { follower, lines } = follow()
        write(2)
        follower.check()
        writeAtOnce(500, 1024)
        expect(statSync(logPath).size).toBeGreaterThan(DEBUG_LOG_MAX_BYTES_PER_CHECK)
        follower.close()
        expect(lines).toEqual(written)
      },
      LARGE_FILE_TIMEOUT_MS
    )

    it('finishes a hand-over that was under way', () => {
      const { follower, lines } = follow()
      write(3)
      follower.check()
      write(2)
      renameSync(logPath, logPath + '.1')
      write(4)
      follower.close()
      expect(lines).toEqual(written)
      expect(readdirSync(dir)).toEqual(['usage.log'])
    })

    it('does nothing afterwards, and releases its descriptor', () => {
      const { fs: facade, calls } = instrumentedFs()
      const { follower, lines } = follow({ fs: facade })
      write(2)
      follower.check()
      follower.close()
      expect(calls.closeSync).toBe(calls.openSync)

      const before = { ...calls }
      const delivered = lines.length
      write(3)
      follower.check()
      follower.close()
      expect(calls).toEqual(before)
      expect(lines.length).toBe(delivered)
    })

    it('does not rotate or delete the log on the final read', () => {
      const { follower, lines, events } = follow({ rotateBytes: 256 })
      write(10)
      follower.close()
      expect(lines).toEqual(written)
      expect(events).toEqual([])
      expect(readdirSync(dir)).toEqual(['usage.log'])
    })

    it('can be called by the consumer from inside a check', () => {
      const lines: string[] = []
      const { fs: facade, calls } = instrumentedFs()
      const follower: DebugLogFollower = new DebugLogFollower({
        path: logPath,
        fs: facade,
        onLine: (line) => {
          lines.push(line)
          if (lines.length === 2) follower.close()
        }
      })
      write(5)
      follower.check()
      expect(lines).toEqual(written)
      expect(calls.closeSync).toBe(calls.openSync)

      write(1)
      follower.check()
      expect(lines.length).toBe(5)
    })
  })
})
