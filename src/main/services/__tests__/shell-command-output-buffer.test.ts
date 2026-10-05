import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ShellCommandOutputBuffer,
  appendToShellCommandLog,
  readShellCommandLogTail,
  trimShellCommandLog
} from '../shell-command-output-buffer'
import {
  SHELL_COMMAND_LOG_CAP_BYTES,
  SHELL_COMMAND_LOG_TRUNCATED_MARKER as MARKER
} from '../shell-command-run-host'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('ShellCommandOutputBuffer', () => {
  let dir: string
  let logFile: string
  let published: string[]
  const publish = (chunk: string): void => {
    published.push(chunk)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shellcmd-buffer-'))
    logFile = join(dir, 'output.log')
    published = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('coalesces several appends into one publish on the next tick', async () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    buffer.append('one ')
    buffer.append('two ')
    buffer.append('three')
    expect(published).toEqual([])

    await nextImmediate()

    expect(published).toEqual(['one two three'])
    await nextImmediate()
    expect(published).toHaveLength(1)
    buffer.close()
  })

  it('flush() publishes synchronously and cancels the scheduled tick', async () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    buffer.append('a')
    buffer.append('b')
    buffer.flush()
    expect(published).toEqual(['ab'])

    buffer.flush()
    await nextImmediate()
    expect(published).toEqual(['ab'])

    buffer.append('c')
    await nextImmediate()
    expect(published).toEqual(['ab', 'c'])
    buffer.close()
  })

  it('snapshot() equals everything that was published', () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    for (let i = 0; i < 50; i++) {
      buffer.append(`line ${i}\r\n`)
      if (i % 7 === 0) buffer.flush()
    }
    buffer.flush()
    expect(buffer.truncated).toBe(false)
    expect(buffer.snapshot()).toBe(published.join(''))
    buffer.close()
  })

  it('defaults the cap to the shared 5 MiB constant', () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    const chunk = 'x'.repeat(1024 * 1024 - 1) + '\n'
    for (let i = 0; i < 5; i++) buffer.append(chunk)
    expect(buffer.truncated).toBe(false)
    buffer.append('y\n')
    expect(buffer.truncated).toBe(true)
    expect(Buffer.byteLength(buffer.snapshot())).toBeLessThanOrEqual(
      SHELL_COMMAND_LOG_CAP_BYTES + MARKER.length
    )
    buffer.close()
  })

  it('drops whole chunks from the head above the cap and prefixes the marker', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 30, publish })
    buffer.append('aaaaaaaaa\n') // 10 bytes
    buffer.append('bbbbbbbbb\n')
    buffer.append('ccccccccc\n')
    expect(buffer.truncated).toBe(false)
    expect(buffer.snapshot()).toBe('aaaaaaaaa\nbbbbbbbbb\nccccccccc\n')

    buffer.append('dd\nee\n')
    expect(buffer.truncated).toBe(true)
    // The 'a' chunk is dropped to fit; the head ('b' line) is then cut at its newline.
    expect(buffer.snapshot()).toBe(MARKER + 'ccccccccc\ndd\nee\n')

    // Publishing is not affected by the cap.
    buffer.flush()
    expect(published.join('')).toBe('aaaaaaaaa\nbbbbbbbbb\nccccccccc\ndd\nee\n')
    buffer.close()
  })

  it('keeps the tail of a single chunk larger than the cap', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 16, publish })
    buffer.append('0123456789\nabcdefghij\nKLMNOPQRST')
    expect(buffer.truncated).toBe(true)
    // Last 16 bytes are 'fghij\nKLMNOPQRST'; the head is cut at the newline.
    expect(buffer.snapshot()).toBe(MARKER + 'KLMNOPQRST')
    buffer.close()
  })

  it('keeps a truncated head without a newline as it is', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 8, publish })
    buffer.append('0123456789abcdef')
    expect(buffer.snapshot()).toBe(MARKER + '89abcdef')
    buffer.close()
  })

  it('never splits a multi-byte character when cutting an oversized chunk', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 7, publish })
    // Each '€' is 3 bytes: a 7-byte tail starts in the middle of one.
    buffer.append('€€€€€')
    expect(buffer.snapshot()).toBe(MARKER + '€€')
    expect(buffer.snapshot()).not.toContain('�')
    buffer.close()
  })

  it('appends every flush to the log file (in-app mode)', () => {
    const buffer = new ShellCommandOutputBuffer({ logFile, publish })
    expect(existsSync(logFile)).toBe(false)
    buffer.append('first\r\n')
    buffer.flush()
    expect(readFileSync(logFile, 'utf8')).toBe('first\r\n')
    expect(statSync(logFile).mode & 0o777).toBe(0o600)

    buffer.append('second ✓\r\n')
    buffer.flush()
    expect(readFileSync(logFile, 'utf8')).toBe('first\r\nsecond ✓\r\n')
    buffer.close()
    expect(readFileSync(logFile, 'utf8')).toBe(buffer.snapshot())
  })

  it('does not create a log file without a logFile option', () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    buffer.append('x')
    buffer.flush()
    buffer.close()
    expect(existsSync(logFile)).toBe(false)
  })

  it('rewrites the log file once it exceeds twice the cap', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 100, logFile, publish })
    const line = (n: number): string => `line-${String(n).padStart(3, '0')}\n` // 9 bytes
    let sent = ''
    for (let i = 0; i < 22; i++) {
      buffer.append(line(i))
      buffer.flush()
      sent += line(i)
    }
    // 198 bytes: still the plain append-only file.
    expect(readFileSync(logFile, 'utf8')).toBe(sent)

    buffer.append(line(22))
    buffer.flush()
    // 207 bytes > 2 x cap: rewritten to the marker plus the retained tail.
    const rewritten = readFileSync(logFile, 'utf8')
    expect(rewritten).toBe(buffer.snapshot())
    expect(rewritten.startsWith(MARKER)).toBe(true)
    expect(rewritten.endsWith(line(22))).toBe(true)
    expect(existsSync(logFile + '.tmp')).toBe(false)

    // Appending continues on the reopened file.
    buffer.append(line(23))
    buffer.flush()
    expect(readFileSync(logFile, 'utf8')).toBe(rewritten + line(23))
    buffer.close()
  })

  it('close() flushes and leaves the file equal to snapshot()', () => {
    const buffer = new ShellCommandOutputBuffer({ capBytes: 40, logFile, publish })
    for (let i = 0; i < 8; i++) buffer.append(`row ${i}\n`)
    buffer.flush()
    buffer.append('pending tail\n')
    buffer.close()

    expect(published.join('')).toContain('pending tail\n')
    expect(buffer.truncated).toBe(true)
    expect(readFileSync(logFile, 'utf8')).toBe(buffer.snapshot())
    expect(buffer.snapshot().startsWith(MARKER)).toBe(true)
    expect(buffer.snapshot().endsWith('pending tail\n')).toBe(true)
    expect(() => buffer.close()).not.toThrow()
  })

  it('append after close is a no-op', async () => {
    const buffer = new ShellCommandOutputBuffer({ logFile, publish })
    buffer.append('kept')
    buffer.close()
    const before = buffer.snapshot()

    buffer.append('dropped')
    buffer.flush()
    await nextImmediate()

    expect(published).toEqual(['kept'])
    expect(buffer.snapshot()).toBe(before)
    expect(readFileSync(logFile, 'utf8')).toBe('kept')
  })

  it('a pending tick after close publishes nothing twice', async () => {
    const buffer = new ShellCommandOutputBuffer({ publish })
    buffer.append('once')
    buffer.close()
    await nextImmediate()
    expect(published).toEqual(['once'])
  })

  it('file errors never reach the data path', () => {
    const buffer = new ShellCommandOutputBuffer({
      logFile: join(dir, 'missing-dir', 'output.log'),
      publish
    })
    buffer.append('a')
    expect(() => buffer.flush()).not.toThrow()
    buffer.append('b')
    expect(() => buffer.flush()).not.toThrow()
    expect(published).toEqual(['a', 'b'])
    expect(buffer.snapshot()).toBe('ab')
    expect(() => buffer.close()).not.toThrow()
  })

  it('a throwing publisher does not break the buffer', () => {
    const buffer = new ShellCommandOutputBuffer({
      logFile,
      publish: () => {
        throw new Error('bus down')
      }
    })
    buffer.append('still logged')
    expect(() => buffer.flush()).not.toThrow()
    expect(readFileSync(logFile, 'utf8')).toBe('still logged')
    buffer.close()
  })
})

describe('shell command log helpers', () => {
  let dir: string
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shellcmd-log-'))
    logFile = join(dir, 'output.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('readShellCommandLogTail returns an empty string for a missing file', () => {
    expect(readShellCommandLogTail(logFile)).toBe('')
  })

  it('readShellCommandLogTail returns a small file whole', () => {
    writeFileSync(logFile, 'hello\r\nworld ✓\r\n')
    expect(readShellCommandLogTail(logFile)).toBe('hello\r\nworld ✓\r\n')
    expect(readShellCommandLogTail(logFile, Buffer.byteLength('hello\r\nworld ✓\r\n'))).toBe(
      'hello\r\nworld ✓\r\n'
    )
  })

  it('readShellCommandLogTail cuts a larger file at a newline and prefixes the marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}\n`)
    writeFileSync(logFile, lines.join(''))
    // 9 bytes per line; a 40-byte tail starts inside line 95.
    expect(readShellCommandLogTail(logFile, 40)).toBe(MARKER + lines.slice(96).join(''))
  })

  it('readShellCommandLogTail reads a multi-megabyte tail across read chunks', () => {
    const line = 'y'.repeat(99) + '\n'
    writeFileSync(logFile, line.repeat(3000))
    const tail = readShellCommandLogTail(logFile, 200_000 + 50)
    expect(tail).toBe(MARKER + line.repeat(2000))
  })

  it('trimShellCommandLog shrinks an oversized log to the marker plus its tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}\n`)
    writeFileSync(logFile, lines.join(''))
    trimShellCommandLog(logFile, 40)
    expect(readFileSync(logFile, 'utf8')).toBe(MARKER + lines.slice(96).join(''))
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(existsSync(logFile + '.tmp')).toBe(false)
  })

  it('trimShellCommandLog leaves a small log alone and never throws', () => {
    writeFileSync(logFile, 'small\n')
    trimShellCommandLog(logFile, 40)
    expect(readFileSync(logFile, 'utf8')).toBe('small\n')
    expect(() => trimShellCommandLog(join(dir, 'missing.log'), 40)).not.toThrow()
  })

  it('a multi-byte character survives a trim boundary without throwing', () => {
    // 3-byte characters, no newline: the cut lands inside one of them.
    writeFileSync(logFile, '€'.repeat(20))
    const tail = readShellCommandLogTail(logFile, 10)
    expect(tail).toBe(MARKER + '€€€')
    expect(tail).not.toContain('�')

    expect(() => trimShellCommandLog(logFile, 10)).not.toThrow()
    expect(readFileSync(logFile, 'utf8')).toBe(MARKER + '€€€')
  })

  it('appendToShellCommandLog appends and swallows errors', () => {
    appendToShellCommandLog(logFile, 'a')
    appendToShellCommandLog(logFile, 'b')
    expect(readFileSync(logFile, 'utf8')).toBe('ab')
    expect(() => appendToShellCommandLog(join(dir, 'nope', 'output.log'), 'x')).not.toThrow()
  })
})
