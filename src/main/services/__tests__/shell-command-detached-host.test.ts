import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detachedRunPreflight,
  parseDetachedExitFile,
  parseInnerFile,
  readDetachedRunResult,
  resolveDetachedExit
} from '../shell-command-detached-host'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

describe('parseDetachedExitFile', () => {
  it('reads script and wrapper statuses', () => {
    expect(parseDetachedExitFile('script=0\nwrapper=0\n')).toEqual({ script: 0, wrapper: 0 })
    expect(parseDetachedExitFile('script=44\nwrapper=300\n')).toEqual({ script: 44, wrapper: 300 })
  })

  it('treats the wrapper line as optional', () => {
    expect(parseDetachedExitFile('script=9\n')).toEqual({ script: 9, wrapper: null })
    expect(parseDetachedExitFile('script=153\nwrapper=\n')).toEqual({ script: 153, wrapper: null })
  })

  it('returns null for anything without a script line', () => {
    expect(parseDetachedExitFile('')).toBeNull()
    expect(parseDetachedExitFile('garbage')).toBeNull()
    expect(parseDetachedExitFile('wrapper=3\n')).toBeNull()
    expect(parseDetachedExitFile('script=abc\n')).toBeNull()
    expect(parseDetachedExitFile('script=-1\n')).toBeNull()
    expect(parseDetachedExitFile(' script=1\n')).toBeNull()
  })
})

describe('resolveDetachedExit', () => {
  // The measured facts behind the table (macOS zsh/bash, Debian bash).
  it.each([
    { script: 0, wrapper: 0, platform: 'darwin', exitCode: 0, abnormal: false, reason: null },
    { script: 3, wrapper: 3, platform: 'darwin', exitCode: 3, abnormal: false, reason: null },
    { script: 130, wrapper: 130, platform: 'linux', exitCode: 130, abnormal: false, reason: null },
    // zsh `exit 300`: script(1) sees 300 & 255.
    { script: 44, wrapper: 300, platform: 'darwin', exitCode: 44, abnormal: false, reason: null },
    // Shell SIGKILLed: macOS script(1) reports the raw signal number, Linux 128 + n.
    { script: 9, wrapper: null, platform: 'darwin', exitCode: 137, abnormal: true, reason: null },
    { script: 137, wrapper: null, platform: 'linux', exitCode: 137, abnormal: true, reason: null },
    { script: 9, wrapper: null, platform: 'linux', exitCode: 9, abnormal: false, reason: null },
    // A step that exec'd (or installed its own EXIT trap) exits with its own status.
    { script: 3, wrapper: null, platform: 'darwin', exitCode: 3, abnormal: false, reason: null },
    { script: 64, wrapper: null, platform: 'darwin', exitCode: 64, abnormal: false, reason: null },
    { script: 65, wrapper: null, platform: 'darwin', exitCode: 65, abnormal: false, reason: null },
    // script(1) itself died of SIGXFSZ: the log hit the ulimit backstop.
    {
      script: 153,
      wrapper: 1,
      platform: 'darwin',
      exitCode: 153,
      abnormal: true,
      reason: 'output-limit'
    },
    {
      script: 153,
      wrapper: null,
      platform: 'darwin',
      exitCode: 153,
      abnormal: true,
      reason: 'output-limit'
    },
    {
      script: 153,
      wrapper: 0,
      platform: 'linux',
      exitCode: 153,
      abnormal: true,
      reason: 'output-limit'
    },
    { script: 0, wrapper: null, platform: 'darwin', exitCode: 0, abnormal: true, reason: null },
    { script: 0, wrapper: 5, platform: 'darwin', exitCode: 5, abnormal: true, reason: null },
    { script: 2, wrapper: 7, platform: 'darwin', exitCode: 2, abnormal: true, reason: null }
  ] as const)(
    'script=$script wrapper=$wrapper on $platform -> $exitCode',
    ({ script, wrapper, platform, exitCode, abnormal, reason }) => {
      expect(resolveDetachedExit({ script, wrapper }, platform)).toEqual({
        exitCode,
        abnormal,
        reason
      })
    }
  )
})

describe('parseInnerFile', () => {
  it('accepts macOS and Linux pty paths', () => {
    expect(parseInnerFile('pid=4321\ntty=/dev/ttys012\n')).toEqual({
      pid: 4321,
      tty: '/dev/ttys012'
    })
    expect(parseInnerFile('pid=77\ntty=/dev/pts/3\n')).toEqual({ pid: 77, tty: '/dev/pts/3' })
  })

  it('rejects anything else', () => {
    expect(parseInnerFile('')).toBeNull()
    expect(parseInnerFile('pid=1\n')).toBeNull()
    expect(parseInnerFile('tty=/dev/ttys001\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=not a tty\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=/dev/null\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=/dev/ttys001; rm -rf /\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=/dev/pts/../sda\n')).toBeNull()
    expect(parseInnerFile('pid=1\ntty=/tmp/ttys001\n')).toBeNull()
    expect(parseInnerFile('pid=x\ntty=/dev/ttys001\n')).toBeNull()
  })
})

describe('readDetachedRunResult', () => {
  let runDir: string

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'shellcmd-result-'))
  })

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  it('is null while there is no exit file', () => {
    expect(readDetachedRunResult(runDir)).toBeNull()
    expect(readDetachedRunResult(join(runDir, 'missing'))).toBeNull()
  })

  it('resolves a normal exit', () => {
    writeFileSync(join(runDir, 'exit'), 'script=0\nwrapper=0\n')
    expect(readDetachedRunResult(runDir, 'darwin')).toEqual({
      kind: 'exited',
      exitCode: 0,
      signal: null,
      abnormal: false
    })
    writeFileSync(join(runDir, 'exit'), 'script=3\nwrapper=3\n')
    expect(readDetachedRunResult(runDir, 'linux')).toEqual({
      kind: 'exited',
      exitCode: 3,
      signal: null,
      abnormal: false
    })
  })

  it('carries the output-limit reason', () => {
    writeFileSync(join(runDir, 'exit'), 'script=153\n')
    expect(readDetachedRunResult(runDir, 'darwin')).toEqual({
      kind: 'exited',
      exitCode: 153,
      signal: null,
      abnormal: true,
      reason: 'output-limit'
    })
  })

  it('applies the platform rule for a killed shell', () => {
    writeFileSync(join(runDir, 'exit'), 'script=9\n')
    expect(readDetachedRunResult(runDir, 'darwin')).toMatchObject({ exitCode: 137, abnormal: true })
    // On Linux a signal is reported as 128 + n; a bare 9 is a program's own status.
    expect(readDetachedRunResult(runDir, 'linux')).toMatchObject({ exitCode: 9, abnormal: false })
    writeFileSync(join(runDir, 'exit'), 'script=137\n')
    expect(readDetachedRunResult(runDir, 'linux')).toMatchObject({ exitCode: 137, abnormal: true })
  })

  it('reports an unparsable exit file as an abnormal failure', () => {
    writeFileSync(join(runDir, 'exit'), 'garbage\n')
    expect(readDetachedRunResult(runDir)).toEqual({
      kind: 'exited',
      exitCode: 1,
      signal: null,
      abnormal: true
    })
  })
})

describe('detachedRunPreflight', () => {
  const savedPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = savedPath
  })

  it('rejects Windows', () => {
    expect(detachedRunPreflight('win32')).toBe('Shell commands are not supported on Windows')
  })

  it.skipIf(process.platform === 'win32')(
    'names the missing utility when script or mkfifo is not on PATH',
    () => {
      const message =
        'This command is set to keep running if the app quits, which needs the system `script` utility. Install it or untick the option.'
      const emptyDir = mkdtempSync(join(tmpdir(), 'shellcmd-preflight-'))
      try {
        process.env.PATH = emptyDir
        // linux looks script up on PATH; darwin uses /usr/bin/script but still needs mkfifo.
        expect(detachedRunPreflight('linux')).toBe(message)
        expect(detachedRunPreflight('darwin')).toBe(message)

        // A non-executable file is not a utility.
        writeFileSync(join(emptyDir, 'script'), '', { mode: 0o644 })
        writeFileSync(join(emptyDir, 'mkfifo'), '', { mode: 0o644 })
        expect(detachedRunPreflight('linux')).toBe(message)

        chmodSync(join(emptyDir, 'script'), 0o755)
        expect(detachedRunPreflight('linux')).toBe(message)
        chmodSync(join(emptyDir, 'mkfifo'), 0o755)
        expect(detachedRunPreflight('linux')).toBeNull()
      } finally {
        rmSync(emptyDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'passes on macOS, where script(1) ships with the OS',
    () => {
      expect(detachedRunPreflight('darwin')).toBeNull()
      expect(detachedRunPreflight()).toBeNull()
    }
  )
})
