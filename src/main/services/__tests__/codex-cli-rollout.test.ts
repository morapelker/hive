import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  extractCodexPlanText,
  findCodexRolloutByIdPrefix,
  lastCodexContextLength,
  parseRolloutFileName,
  readRolloutCwd,
  recentRolloutDirs,
  resolveCodexHome,
  resolveCodexSessionsDir,
  rolloutThreadIdFromPath,
  tallyCodexTranscriptTokens,
  watchCodexTurnEnd,
  watchForCodexSessionId,
  type CodexTurnEnd
} from '../codex-cli-rollout'
import { appendFileSync } from 'node:fs'

const THREAD = '01a07dbd-6a11-7982-a2b6-ceaa43736708'

function line(record: unknown): string {
  return JSON.stringify(record) + '\n'
}

function sessionMeta(cwd: string, id = THREAD): string {
  return line({
    timestamp: '2026-09-07T21:08:40.883Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: id, id, cwd, originator: 'codex-tui', cli_version: '0.153.4' }
  })
}

function tokenCount(last: Record<string, number>): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: last, last_token_usage: last, model_context_window: 258400 }
    }
  })
}

const tempDirs: string[] = []
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('paths', () => {
  it('honors CODEX_HOME and falls back to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/x/codex' })).toBe('/x/codex')
    expect(resolveCodexHome({ CODEX_HOME: '  ' })).toMatch(/\.codex$/)
    expect(resolveCodexSessionsDir({ CODEX_HOME: '/x/codex' })).toBe('/x/codex/sessions')
  })

  it('parses rollout file names and derives thread ids from paths', () => {
    const name = `rollout-2026-09-08T00-08-40-${THREAD}.jsonl`
    expect(parseRolloutFileName(name)).toEqual({ threadId: THREAD })
    expect(parseRolloutFileName('rollout-broken.jsonl')).toBeNull()
    expect(rolloutThreadIdFromPath(`/a/b/${name}`)).toBe(THREAD)
  })

  it('lists today and yesterday folders (deduplicated)', () => {
    const dirs = recentRolloutDirs('/s', new Date(2026, 8, 8, 12))
    expect(dirs).toEqual(['/s/2026/09/08', '/s/2026/09/07'])
  })
})

describe('rollout readers', () => {
  it('reads the session cwd from the first line only', () => {
    const dir = makeTemp()
    const file = join(dir, `rollout-2026-09-08T00-08-40-${THREAD}.jsonl`)
    writeFileSync(file, sessionMeta('/repo/wt') + tokenCount({ input_tokens: 1 }))
    expect(readRolloutCwd(file)).toBe('/repo/wt')
    writeFileSync(file, tokenCount({ input_tokens: 1 }))
    expect(readRolloutCwd(file)).toBeNull()
    expect(readRolloutCwd(join(dir, 'missing.jsonl'))).toBeNull()
  })

  it('extracts the plan of a turn, preferring the requested turn over the latest', () => {
    const transcript =
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't1', item: { type: 'Plan', id: 'p1', text: 'Plan one' } } }) +
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't2', item: { type: 'AgentMessage', id: 'm', text: 'chatter' } } }) +
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 't2', item: { type: 'Plan', id: 'p2', text: '  Plan two  ' } } }) +
      '{"partial":'
    expect(extractCodexPlanText(transcript, 't1')).toBe('Plan one')
    expect(extractCodexPlanText(transcript, 't2')).toBe('Plan two')
    expect(extractCodexPlanText(transcript, 't3')).toBe('Plan two')
    expect(extractCodexPlanText(transcript, null)).toBe('Plan two')
    expect(extractCodexPlanText('', 't1')).toBeNull()
  })

  it('tallies token_count events into anthropic-style counters', () => {
    const transcript =
      tokenCount({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 50, output_tokens: 20 }) +
      tokenCount({ input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 80 }) +
      line({ type: 'response_item', payload: { type: 'message' } })
    expect(tallyCodexTranscriptTokens(transcript)).toEqual({
      input: 600,
      cacheRead: 1600,
      cacheWrite: 50,
      output: 100
    })
    expect(lastCodexContextLength(transcript)).toBe(1200)
    expect(lastCodexContextLength('')).toBeNull()
  })
})

describe('findCodexRolloutByIdPrefix', () => {
  it('finds the rollout whose thread id starts with the (truncated) prefix', () => {
    const sessions = makeTemp()
    const now = new Date(2026, 8, 8, 12)
    const today = join(sessions, '2026', '09', '08')
    mkdirSync(today, { recursive: true })
    const file = join(today, `rollout-2026-09-08T00-08-40-${THREAD}.jsonl`)
    writeFileSync(file, sessionMeta('/repo/wt'))
    expect(findCodexRolloutByIdPrefix(THREAD.slice(0, 29), { sessionsDir: sessions, now })).toEqual({
      threadId: THREAD,
      filePath: file
    })
    expect(findCodexRolloutByIdPrefix('ffffffff-0000', { sessionsDir: sessions, now })).toBeNull()
    expect(findCodexRolloutByIdPrefix('01a0', { sessionsDir: sessions, now })).toBeNull()
  })
})

describe('watchForCodexSessionId', () => {
  it('reports a new rollout for the worktree, skipping other cwds and pre-existing files', async () => {
    const sessions = makeTemp()
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const today = join(sessions, String(y), m, d)
    mkdirSync(today, { recursive: true })
    const preexisting = join(today, 'rollout-2026-09-08T00-00-00-00000000-0000-0000-0000-000000000000.jsonl')
    writeFileSync(preexisting, sessionMeta('/repo/wt', '00000000-0000-0000-0000-000000000000'))

    const seen: string[] = []
    const handle = watchForCodexSessionId(
      '/repo/wt',
      (threadId) => {
        seen.push(threadId)
        return true
      },
      { sessionsDir: sessions, pollMs: 20 }
    )
    try {
      writeFileSync(
        join(today, 'rollout-2026-09-08T00-00-01-11111111-1111-1111-1111-111111111111.jsonl'),
        sessionMeta('/other/dir', '11111111-1111-1111-1111-111111111111')
      )
      writeFileSync(join(today, `rollout-2026-09-08T00-00-02-${THREAD}.jsonl`), sessionMeta('/repo/wt'))
      await vi.waitFor(() => expect(seen).toEqual([THREAD]), { timeout: 2000, interval: 10 })
    } finally {
      handle.close()
    }
  })
})

describe('watchCodexTurnEnd', () => {
  it('reports the failed task_complete of the watched turn, ignoring other turns and earlier records', async () => {
    const dir = makeTemp()
    const file = join(dir, `rollout-2026-09-08T00-08-40-${THREAD}.jsonl`)
    // Pre-existing records (an earlier turn) must not count.
    writeFileSync(
      file,
      sessionMeta('/repo/wt') +
        line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old', last_agent_message: 'x' } })
    )
    const ends: CodexTurnEnd[] = []
    const handle = watchCodexTurnEnd(file, 'turn-2', (end) => ends.push(end), { pollMs: 20 })
    try {
      appendFileSync(file, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }))
      appendFileSync(
        file,
        line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'other', last_agent_message: null } })
      )
      appendFileSync(file, tokenCount({ input_tokens: 5 }))
      await new Promise((r) => setTimeout(r, 80))
      expect(ends).toEqual([])
      appendFileSync(
        file,
        line({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-2',
            last_agent_message: null,
            error: { message: 'unexpected status 404 Not Found: The model `gpt-5.5` does not exist' }
          }
        })
      )
      await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 2000, interval: 10 })
      expect(ends[0]).toEqual({
        kind: 'complete',
        turnId: 'turn-2',
        error: 'unexpected status 404 Not Found: The model `gpt-5.5` does not exist',
        lastAgentMessage: null
      })
    } finally {
      handle.close()
    }
  })

  it('reports an aborted turn and handles a partially written trailing line', async () => {
    const dir = makeTemp()
    const file = join(dir, `rollout-2026-09-08T00-08-40-${THREAD}.jsonl`)
    writeFileSync(file, sessionMeta('/repo/wt'))
    const ends: CodexTurnEnd[] = []
    const handle = watchCodexTurnEnd(file, null, (end) => ends.push(end), { pollMs: 20 })
    try {
      const record = line({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't9', reason: 'interrupted' } })
      appendFileSync(file, record.slice(0, 30))
      await new Promise((r) => setTimeout(r, 60))
      expect(ends).toEqual([])
      appendFileSync(file, record.slice(30))
      await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 2000, interval: 10 })
      expect(ends[0]).toMatchObject({ kind: 'aborted', turnId: 't9', error: null })
    } finally {
      handle.close()
    }
  })
})
