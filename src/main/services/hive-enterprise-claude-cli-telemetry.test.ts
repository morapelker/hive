import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../db/database'
import type { Session } from '../db/types'
import type { DevSessionProvider, DevSessionSnapshot } from './tedooo-dev-session'
import {
  __resetClaudeCliHiveTelemetryForTests,
  handleClaudeCliHiveTelemetryHook,
  lastAssistantContextLengthFromClaudeTranscript,
  readTranscriptRange
} from './hive-enterprise-claude-cli-telemetry'

// Ranged transcript reads: the hook handlers run on the main event loop, so
// the prompt start must only read the transcript tail and the idle tally only
// the bytes appended since the start. These tests inject `readTranscript` to
// prove which byte ranges are requested.

vi.mock('./git-service', () => ({
  GitService: vi.fn().mockImplementation(() => ({
    getRemoteUrl: vi.fn().mockResolvedValue({ success: false })
  }))
}))

vi.mock('./account-service', () => ({
  getClaudeAccountEmail: vi.fn().mockResolvedValue(null),
  getOpenAIAccountEmail: vi.fn().mockResolvedValue(null)
}))

const TAIL_BYTES = 512 * 1024

function assistantLine(usage: {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0
      }
    }
  })
}

function codexTokenCountLine(last: Record<string, number>): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: last, last_token_usage: last } }
  })
}

/** A non-usage line of roughly `bytes` bytes (a big tool result, say). */
function fillerLine(bytes: number): string {
  return JSON.stringify({ type: 'user', message: { content: 'x'.repeat(bytes) } })
}

function fillerText(totalBytes: number): string {
  const line = `${fillerLine(4096)}\n`
  return line.repeat(Math.ceil(totalBytes / Buffer.byteLength(line)))
}

const claudeSession: Session = {
  id: 'session-1',
  worktree_id: null,
  project_id: 'project-1',
  connection_id: null,
  name: 'Session 1',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: 'claude-session-1',
  agent_sdk: 'claude-code-cli',
  mode: 'build',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'sonnet',
  model_variant: null,
  remote_launch: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  pinned_to_board: false
}

function makeDb(session: Session = claudeSession): DatabaseService {
  return {
    getSession: vi.fn(() => session),
    getWorktree: vi.fn(() => null),
    getProject: vi.fn(() => null),
    getConnection: vi.fn(() => null)
  } as unknown as DatabaseService
}

function fakeProvider(): DevSessionProvider & { enqueue: ReturnType<typeof vi.fn> } {
  const snapshot: DevSessionSnapshot = {
    token: 'token-1',
    context: {
      userId: 'alice_user',
      email: null,
      orgId: 'acme_org',
      orgName: 'Acme',
      apiUrl: null,
      policy: {
        storePrompts: true,
        recordQuestions: true,
        forceBoardMode: false,
        minAppVersion: null
      }
    }
  }
  return {
    get: () => snapshot,
    subscribe: () => () => undefined,
    request: vi.fn(),
    enqueue: vi.fn(),
    notify: vi.fn()
  }
}

const tempDirs: string[] = []
function makeTranscript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-telemetry-ranged-'))
  tempDirs.push(dir)
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, text)
  return file
}

/** A reader that records every requested range and otherwise reads the real file. */
function recordingReader(): {
  reader: (path: string, fromOffset?: number) => string
  calls: Array<number | undefined>
} {
  const calls: Array<number | undefined> = []
  return {
    calls,
    reader: (path, fromOffset) => {
      calls.push(fromOffset)
      return readTranscriptRange(path, fromOffset ?? 0)
    }
  }
}

async function submitPrompt(
  transcriptPath: string,
  deps: Parameters<typeof handleClaudeCliHiveTelemetryHook>[2]
): Promise<void> {
  await handleClaudeCliHiveTelemetryHook(
    'session-1',
    { hook_event_name: 'UserPromptSubmit', prompt: 'Continue', transcript_path: transcriptPath },
    deps
  )
}

async function stop(
  transcriptPath: string,
  deps: Parameters<typeof handleClaudeCliHiveTelemetryHook>[2]
): Promise<void> {
  await handleClaudeCliHiveTelemetryHook(
    'session-1',
    { hook_event_name: 'Stop', transcript_path: transcriptPath },
    deps
  )
}

beforeEach(() => {
  __resetClaudeCliHiveTelemetryForTests()
})

afterEach(() => {
  __resetClaudeCliHiveTelemetryForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readTranscriptRange', () => {
  it('reads [start, end) and defaults end to the file size', () => {
    const path = makeTranscript('0123456789')
    expect(readTranscriptRange(path, 0)).toBe('0123456789')
    expect(readTranscriptRange(path, 4)).toBe('456789')
    expect(readTranscriptRange(path, 2, 5)).toBe('234')
  })

  it('clamps the range to the file and yields nothing past its end', () => {
    const path = makeTranscript('0123456789')
    expect(readTranscriptRange(path, 10)).toBe('')
    expect(readTranscriptRange(path, 50)).toBe('')
    expect(readTranscriptRange(path, 8, 100)).toBe('89')
    expect(readTranscriptRange(path, 5, 2)).toBe('')
    expect(readTranscriptRange(path, -3, 2)).toBe('01')
  })

  it('yields nothing for an unreadable file', () => {
    expect(readTranscriptRange('/nonexistent/transcript.jsonl', 0)).toBe('')
  })

  it('offsets are bytes, not characters', () => {
    const path = makeTranscript('héllo\nworld')
    // 'héllo\n' is 7 bytes (é is two).
    expect(readTranscriptRange(path, 7)).toBe('world')
  })
})

describe('lastAssistantContextLengthFromClaudeTranscript', () => {
  it('returns the last assistant usage line, ignoring later non-usage and torn lines', () => {
    const text = [
      assistantLine({ input: 1, cacheRead: 2, cacheWrite: 3 }),
      assistantLine({ input: 100, cacheRead: 20, cacheWrite: 7 }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      '{"type":"assistant","message":{"usage":{"input_tokens":9'
    ].join('\n')
    expect(lastAssistantContextLengthFromClaudeTranscript(text)).toBe(127)
  })

  it('returns null when no assistant usage line exists', () => {
    expect(lastAssistantContextLengthFromClaudeTranscript('')).toBeNull()
    expect(lastAssistantContextLengthFromClaudeTranscript('{"type":"user"}\n')).toBeNull()
  })
})

describe('prompt start transcript reads', () => {
  it('reads at most the last 512 KiB of a large transcript', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 1, cacheRead: 1, cacheWrite: 1 })}\n` +
        fillerText(TAIL_BYTES * 2) +
        `${assistantLine({ input: 100, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const size = statSync(transcriptPath).size
    expect(size).toBeGreaterThan(TAIL_BYTES)
    const { reader, calls } = recordingReader()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db: makeDb(), provider, readTranscript: reader })

    expect(calls).toEqual([size - TAIL_BYTES])
    expect(provider.enqueue.mock.calls[0][0].variables.input).toMatchObject({
      contextLength: 127
    })
  })

  it('reads a small transcript once from the start', async () => {
    const transcriptPath = makeTranscript(`${assistantLine({ input: 40, cacheRead: 2 })}\n`)
    const { reader, calls } = recordingReader()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db: makeDb(), provider, readTranscript: reader })

    expect(calls).toEqual([0])
    expect(provider.enqueue.mock.calls[0][0].variables.input).toMatchObject({ contextLength: 42 })
  })

  it('falls back to the whole file once when the tail holds no usage line', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, cacheRead: 20, cacheWrite: 7 })}\n` +
        fillerText(TAIL_BYTES * 2)
    )
    const size = statSync(transcriptPath).size
    const { reader, calls } = recordingReader()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db: makeDb(), provider, readTranscript: reader })

    expect(calls).toEqual([size - TAIL_BYTES, 0])
    expect(provider.enqueue.mock.calls[0][0].variables.input).toMatchObject({
      contextLength: 127
    })
  })

  it('reports zero context when neither the tail nor the whole file has a usage line', async () => {
    const transcriptPath = makeTranscript(fillerText(TAIL_BYTES + 1024))
    const { reader, calls } = recordingReader()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db: makeDb(), provider, readTranscript: reader })

    expect(calls).toHaveLength(2)
    expect(provider.enqueue.mock.calls[0][0].variables.input).toMatchObject({ contextLength: 0 })
  })

  it('scans the Codex rollout tail for the last token_count', async () => {
    const transcriptPath = makeTranscript(
      fillerText(TAIL_BYTES * 2) +
        `${codexTokenCountLine({ input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 5, output_tokens: 9 })}\n`
    )
    const size = statSync(transcriptPath).size
    const { reader, calls } = recordingReader()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, {
      db: makeDb({ ...claudeSession, agent_sdk: 'codex-cli' }),
      provider,
      readTranscript: reader
    })

    expect(calls).toEqual([size - TAIL_BYTES])
    expect(provider.enqueue.mock.calls[0][0].variables.input).toMatchObject({
      contextLength: 305,
      providerId: 'codex-cli'
    })
  })
})

describe('idle transcript reads', () => {
  it('tallies only the bytes appended after the start offset', async () => {
    const before = `${assistantLine({ input: 900, output: 90, cacheRead: 9, cacheWrite: 1 })}\n`
    const transcriptPath = makeTranscript(before)
    const startSize = Buffer.byteLength(before)
    const db = makeDb()
    const provider = fakeProvider()
    const idleOffsets: Array<number | undefined> = []
    let phase: 'start' | 'idle' = 'start'
    const readTranscript = (path: string, fromOffset?: number): string => {
      if (phase === 'idle') {
        idleOffsets.push(fromOffset)
        // The seam serves the delta: the caller must ask from the start offset
        // rather than read the whole file and slice it.
        expect(fromOffset).toBe(startSize)
      }
      return readTranscriptRange(path, fromOffset ?? 0)
    }

    await submitPrompt(transcriptPath, { db, provider, readTranscript })
    appendFileSync(
      transcriptPath,
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    phase = 'idle'
    await stop(transcriptPath, { db, provider, readTranscript })

    expect(idleOffsets).toEqual([startSize])
    expect(provider.enqueue).toHaveBeenCalledTimes(2)
    expect(provider.enqueue.mock.calls[1][0].variables.input).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 20,
      cacheWriteTokens: 7
    })
  })

  it('requests the transcript exactly once at idle, from the start offset', async () => {
    const before = fillerText(TAIL_BYTES + 4096)
    const transcriptPath = makeTranscript(before)
    const startSize = Buffer.byteLength(before)
    const db = makeDb()
    const provider = fakeProvider()
    const { reader, calls } = recordingReader()

    await submitPrompt(transcriptPath, { db, provider, readTranscript: reader })
    calls.length = 0
    appendFileSync(transcriptPath, `${assistantLine({ input: 3, output: 4 })}\n`)
    await stop(transcriptPath, { db, provider, readTranscript: reader })

    expect(calls).toEqual([startSize])
    expect(provider.enqueue.mock.calls[1][0].variables.input).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    })
  })

  it('reports zero tokens when the transcript shrank below the start offset', async () => {
    const transcriptPath = makeTranscript(`${assistantLine({ input: 50, output: 5 })}\n`)
    const db = makeDb()
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db, provider })
    writeFileSync(transcriptPath, '')
    await stop(transcriptPath, { db, provider })

    expect(provider.enqueue.mock.calls[1][0].variables.input).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    })
  })

  it('tallies Codex token_count lines appended after the offset', async () => {
    const before = `${codexTokenCountLine({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 })}\n`
    const transcriptPath = makeTranscript(before)
    const db = makeDb({ ...claudeSession, agent_sdk: 'codex-cli' })
    const provider = fakeProvider()

    await submitPrompt(transcriptPath, { db, provider })
    appendFileSync(
      transcriptPath,
      `${codexTokenCountLine({ input_tokens: 30, cached_input_tokens: 10, cache_write_input_tokens: 2, output_tokens: 8 })}\n`
    )
    await stop(transcriptPath, { db, provider })

    expect(provider.enqueue.mock.calls[1][0].variables.input).toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheWriteTokens: 2
    })
  })
})
