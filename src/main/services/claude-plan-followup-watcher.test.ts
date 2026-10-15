import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const perf = vi.hoisted(() => ({
  gauges: new Map<string, () => number | Record<string, number>>()
}))
vi.mock('./perf-logging/perf-logger', () => ({
  perfLog: {
    registerGauge: vi.fn((name: string, read: () => number | Record<string, number>) => {
      perf.gauges.set(name, read)
      return () => perf.gauges.delete(name)
    })
  }
}))

const fsSpies = vi.hoisted(() => ({ readSync: vi.fn(), openSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  fsSpies.readSync.mockImplementation(actual.readSync)
  fsSpies.openSync.mockImplementation(actual.openSync)
  return { ...actual, readSync: fsSpies.readSync, openSync: fsSpies.openSync }
})

import { encodePath } from './claude-transcript-reader'
import { readTranscriptAppend, watchForClaudePlanFollowup } from './claude-plan-followup-watcher'

const WORKTREE = '/repo/worktree'
const CLAUDE_SESSION_ID = 'claude-session-1'
const INTERVAL_MS = 50

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`
}

function planToolUse(id = 'toolu_plan'): string {
  return line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: 'Plan' } }]
    }
  })
}

function planFollowup(toolUseId = 'toolu_plan'): string {
  return line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content: 'Please adjust the plan before implementing.'
        }
      ]
    }
  })
}

const userPrompt = line({ type: 'user', message: { role: 'user', content: 'Initial prompt' } })

describe('watchForClaudePlanFollowup', () => {
  let configDir: string
  let transcriptPath: string
  let previousConfigDir: string | undefined
  let handles: Array<{ close(): void }>

  const readSyncCalls = (): number => fsSpies.readSync.mock.calls.length
  const liveWatchers = (): number => perf.gauges.get('claudePlanFollowupWatchers')?.() as number

  const watch = (onPlanFollowup = vi.fn()): { onPlanFollowup: ReturnType<typeof vi.fn> } => {
    handles.push(watchForClaudePlanFollowup(WORKTREE, CLAUDE_SESSION_ID, onPlanFollowup, INTERVAL_MS))
    // The seeding read is deferred off the arming call (setImmediate); fake timers run it here.
    vi.advanceTimersByTime(0)
    return { onPlanFollowup }
  }

  const tick = (count = 1): void => {
    vi.advanceTimersByTime(INTERVAL_MS * count)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    handles = []
    configDir = mkdtempSync(join(tmpdir(), 'plan-followup-watcher-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    const projectDir = join(configDir, 'projects', encodePath(WORKTREE))
    mkdirSync(projectDir, { recursive: true })
    transcriptPath = join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`)
    fsSpies.readSync.mockClear()
    fsSpies.openSync.mockClear()
  })

  afterEach(() => {
    for (const handle of handles) handle.close()
    vi.useRealTimers()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  it('reports a follow-up appended after the watcher started, seeded from the existing plan tool_use', () => {
    writeFileSync(transcriptPath, userPrompt + planToolUse())
    const { onPlanFollowup } = watch()

    tick()
    expect(onPlanFollowup).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, planFollowup())
    tick()

    expect(onPlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('ignores a follow-up that already existed when the watcher started', () => {
    writeFileSync(transcriptPath, planToolUse() + planFollowup())
    const { onPlanFollowup } = watch()

    tick(3)

    expect(onPlanFollowup).not.toHaveBeenCalled()
  })

  it('does not read any bytes on a tick when the transcript has not grown', () => {
    writeFileSync(transcriptPath, userPrompt + planToolUse())
    watch()
    const afterBaseline = readSyncCalls()
    expect(afterBaseline).toBe(1)

    tick(5)

    expect(readSyncCalls()).toBe(afterBaseline)
    // Every tick still stats the file (one open per tick) to notice growth.
    expect(fsSpies.openSync.mock.calls.length).toBe(6)
  })

  it('reads only the appended bytes, not the whole transcript', () => {
    const existing = userPrompt + planToolUse()
    writeFileSync(transcriptPath, existing)
    watch()

    const appended = planFollowup('toolu_other')
    appendFileSync(transcriptPath, appended)
    tick()

    const lastRead = fsSpies.readSync.mock.calls.at(-1)!
    // readSync(fd, buffer, offset, length, position)
    expect(lastRead[3]).toBe(Buffer.byteLength(appended))
    expect(lastRead[4]).toBe(Buffer.byteLength(existing))
  })

  it('waits for a torn trailing line to settle instead of parsing it in halves', () => {
    writeFileSync(transcriptPath, planToolUse())
    const { onPlanFollowup } = watch()

    const followup = planFollowup()
    const cut = Math.floor(followup.length / 2)
    appendFileSync(transcriptPath, followup.slice(0, cut))
    tick()
    expect(onPlanFollowup).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, followup.slice(cut))
    tick()
    expect(onPlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('treats a torn trailing line present at start as part of the baseline once it settles', () => {
    const followup = planFollowup()
    const cut = Math.floor(followup.length / 2)
    writeFileSync(transcriptPath, planToolUse() + followup.slice(0, cut))
    const { onPlanFollowup } = watch()

    appendFileSync(transcriptPath, followup.slice(cut))
    tick(2)
    expect(onPlanFollowup).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, planFollowup())
    tick()
    expect(onPlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('restarts from scratch when the transcript shrinks (rewritten file)', () => {
    writeFileSync(transcriptPath, userPrompt.repeat(20) + planToolUse('toolu_old'))
    const { onPlanFollowup } = watch()
    tick()

    // Rewritten shorter: its content is a fresh baseline, including a follow-up
    // already inside it, and the old tool id no longer counts.
    const rewritten = planToolUse('toolu_new') + planFollowup('toolu_new')
    expect(rewritten.length).toBeLessThan(userPrompt.length * 20)
    writeFileSync(transcriptPath, rewritten)
    tick(2)
    expect(onPlanFollowup).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, planFollowup('toolu_old'))
    tick()
    expect(onPlanFollowup).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, planFollowup('toolu_new'))
    tick()
    expect(onPlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('keeps polling until the transcript appears', () => {
    const { onPlanFollowup } = watch()
    tick(2)

    writeFileSync(transcriptPath, planToolUse())
    tick()
    appendFileSync(transcriptPath, planFollowup())
    tick()

    expect(onPlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('stops polling once closed or once a follow-up fired', () => {
    writeFileSync(transcriptPath, planToolUse())
    const first = watch()
    const second = watch()
    tick()

    handles[0].close()
    const opensAfterClose = fsSpies.openSync.mock.calls.length
    appendFileSync(transcriptPath, planFollowup())
    tick()

    expect(first.onPlanFollowup).not.toHaveBeenCalled()
    expect(second.onPlanFollowup).toHaveBeenCalledTimes(1)
    // Only the second watcher opened the file on that tick, and it is now closed too.
    expect(fsSpies.openSync.mock.calls.length).toBe(opensAfterClose + 1)
    tick(3)
    expect(fsSpies.openSync.mock.calls.length).toBe(opensAfterClose + 1)
  })

  it('exposes the number of open watchers as a perf gauge', () => {
    const before = liveWatchers()
    watch()
    watch()
    expect(liveWatchers()).toBe(before + 2)

    handles[0].close()
    handles[0].close()
    expect(liveWatchers()).toBe(before + 1)

    writeFileSync(transcriptPath, planToolUse())
    tick()
    appendFileSync(transcriptPath, planFollowup())
    tick()
    expect(liveWatchers()).toBe(before)
  })
})

describe('readTranscriptAppend', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-followup-read-'))
    filePath = join(dir, 'transcript.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns complete lines and advances the offset past the last newline', () => {
    writeFileSync(filePath, 'a\nb\r\npartial')
    const result = readTranscriptAppend(filePath, 0)
    expect(result).toEqual({ lines: ['a', 'b'], offset: 5, size: 12, truncated: false })

    appendFileSync(filePath, '\n')
    expect(readTranscriptAppend(filePath, result.offset)).toEqual({
      lines: ['partial'],
      offset: 13,
      size: 13,
      truncated: false
    })
  })

  it('does not split a multi-byte character straddling a torn line', () => {
    writeFileSync(filePath, Buffer.concat([Buffer.from('ok\n'), Buffer.from('é').subarray(0, 1)]))
    expect(readTranscriptAppend(filePath, 0)).toEqual({
      lines: ['ok'],
      offset: 3,
      size: 4,
      truncated: false
    })
  })

  it('flags a file that shrank below the offset', () => {
    writeFileSync(filePath, 'short\n')
    expect(readTranscriptAppend(filePath, 100)).toEqual({
      lines: [],
      offset: 0,
      size: 6,
      truncated: true
    })
  })
})
