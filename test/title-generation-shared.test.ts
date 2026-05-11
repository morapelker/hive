import { beforeEach, describe, it, expect, vi } from 'vitest'

const runPromiseMock = vi.hoisted(() => vi.fn())

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../src/main/effect/spawn/runtime', () => ({
  getRuntime: () => ({ runPromise: runPromiseMock })
}))

import {
  sanitizeTitle,
  extractTitleFromJSON,
  spawnCLI,
  SpawnCliError
} from '../src/main/services/title-generation-shared'
import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from '../src/main/effect/spawn/errors'

beforeEach(() => {
  runPromiseMock.mockReset()
})

// ── sanitizeTitle ────────────────────────────────────────────────────

describe('sanitizeTitle', () => {
  it('returns trimmed single-line title as-is', () => {
    expect(sanitizeTitle('Fix auth bug')).toBe('Fix auth bug')
  })

  it('takes only first line from multiline input', () => {
    expect(sanitizeTitle('First line\nSecond line\nThird line')).toBe('First line')
  })

  it('strips surrounding double quotes', () => {
    expect(sanitizeTitle('"Fix auth bug"')).toBe('Fix auth bug')
  })

  it('strips surrounding single quotes', () => {
    expect(sanitizeTitle("'Fix auth bug'")).toBe('Fix auth bug')
  })

  it('strips surrounding backticks', () => {
    expect(sanitizeTitle('`Fix auth bug`')).toBe('Fix auth bug')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeTitle('Fix   auth    bug')).toBe('Fix auth bug')
  })

  it('returns null for empty string', () => {
    expect(sanitizeTitle('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(sanitizeTitle('   \t  \n  ')).toBeNull()
  })

  it('truncates at 50 chars with ellipsis', () => {
    const long = 'A'.repeat(60)
    const result = sanitizeTitle(long)
    expect(result).toBe('A'.repeat(50) + '...')
    expect(result!.length).toBe(53)
  })

  it('returns full title when exactly 50 chars', () => {
    const exact = 'A'.repeat(50)
    expect(sanitizeTitle(exact)).toBe(exact)
  })

  it('returns full title when under 50 chars', () => {
    const short = 'A'.repeat(30)
    expect(sanitizeTitle(short)).toBe(short)
  })

  it('extracts title from double-wrapped JSON (the bug case)', () => {
    expect(sanitizeTitle('{"title": "Codex vs t3"}')).toBe('Codex vs t3')
  })

  it('extracts title from double-wrapped JSON with extra fields', () => {
    expect(sanitizeTitle('{"title": "Fix auth bug", "confidence": 0.9}')).toBe('Fix auth bug')
  })

  it('passes through JSON without title field unchanged', () => {
    expect(sanitizeTitle('{"other": "value"}')).toBe('{"other": "value"}')
  })
})

// ── extractTitleFromJSON ─────────────────────────────────────────────

describe('extractTitleFromJSON', () => {
  it('extracts from Claude -p envelope (structured_output)', () => {
    const input = JSON.stringify({ structured_output: { title: 'Fix auth bug' } })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from direct JSON', () => {
    const input = JSON.stringify({ title: 'Fix auth bug' })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from nested result string', () => {
    const input = JSON.stringify({ result: JSON.stringify({ title: 'Fix auth bug' }) })
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('extracts from text with embedded JSON', () => {
    const input = 'Some text {"title":"Fix auth bug"} more text'
    expect(extractTitleFromJSON(input)).toBe('Fix auth bug')
  })

  it('returns null for empty string', () => {
    expect(extractTitleFromJSON('')).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(extractTitleFromJSON('just some plain text')).toBeNull()
  })

  it('returns null for JSON without title key', () => {
    const input = JSON.stringify({ other: 'value' })
    expect(extractTitleFromJSON(input)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(extractTitleFromJSON('{not valid json')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(extractTitleFromJSON('   \t\n  ')).toBeNull()
  })
})

// ── spawnCLI compatibility shim ─────────────────────────────────────

describe('spawnCLI', () => {
  it('returns stdout from Spawn.runOnce', async () => {
    runPromiseMock.mockResolvedValue({ stdout: 'Generated title\n', stderr: '', exitCode: 0 })

    await expect(spawnCLI('tool', ['arg'], 'input', 123, '/tmp', { A: 'B' })).resolves.toBe(
      'Generated title\n'
    )

    expect(runPromiseMock).toHaveBeenCalled()
  })

  it.each([
    [
      new SpawnTimeout({
        command: 'tool',
        durationMs: 123,
        stdoutPreview: 'partial out',
        stderrPreview: 'partial err'
      }),
      'timeout',
      { timeoutMs: 123 }
    ],
    [
      new SpawnFailed({ command: 'tool', cause: new Error('ENOENT') }),
      'spawn_error',
      {}
    ],
    [
      new SpawnNonZeroExit({
        command: 'tool',
        exitCode: 7,
        stdoutPreview: 'partial out',
        stderrPreview: 'partial err'
      }),
      'non_zero_exit',
      { code: 7 }
    ],
    [
      new SpawnOutputCapExceeded({ command: 'tool', stream: 'stdout', bytes: 4, limit: 3 }),
      'stdout_too_large',
      { maxOutputBytes: 3 }
    ],
    [
      new SpawnOutputCapExceeded({ command: 'tool', stream: 'stderr', bytes: 4, limit: 3 }),
      'stderr_too_large',
      { maxOutputBytes: 3 }
    ],
    [
      new SpawnSignalled({
        command: 'tool',
        signal: 'SIGTERM',
        stdoutPreview: 'partial out',
        stderrPreview: 'partial err'
      }),
      'spawn_error',
      {}
    ]
  ] as const)('maps %s to SpawnCliError kind %s', async (taggedError, kind, details) => {
    runPromiseMock.mockRejectedValue(taggedError)

    await expect(spawnCLI('tool', ['arg'], 'input', 999, '/tmp')).rejects.toMatchObject({
      name: 'SpawnCliError',
      kind,
      command: 'tool',
      cwd: '/tmp',
      ...details
    } satisfies Partial<SpawnCliError>)
  })
})
