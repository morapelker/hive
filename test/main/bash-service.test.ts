// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { BashService, type BashStreamEvent } from '../../src/main/services/bash-service'

interface MockWindow {
  isDestroyed: () => boolean
  webContents: {
    send: (channel: string, event: BashStreamEvent) => void
  }
}

interface RecordedEvent {
  channel: string
  event: BashStreamEvent
}

function createMockWindow(events: RecordedEvent[]): MockWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: BashStreamEvent) => {
        events.push({ channel, event })
      }
    }
  }
}

function eventsForSession(events: RecordedEvent[], sessionId: string): BashStreamEvent[] {
  return events
    .filter((e) => e.channel === 'bash:stream' && e.event.sessionId === sessionId)
    .map((e) => e.event)
}

function findEnd(events: BashStreamEvent[]): Extract<BashStreamEvent, { type: 'end' }> | undefined {
  return events.find((e): e is Extract<BashStreamEvent, { type: 'end' }> => e.type === 'end')
}

function joinedOutput(events: BashStreamEvent[]): string {
  return events
    .filter((e): e is Extract<BashStreamEvent, { type: 'output' }> => e.type === 'output')
    .map((e) => e.data)
    .join('')
}

async function waitForEnd(
  events: RecordedEvent[],
  sessionId: string,
  timeoutMs: number
): Promise<Extract<BashStreamEvent, { type: 'end' }>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const end = findEnd(eventsForSession(events, sessionId))
    if (end) return end
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for end event for ${sessionId}`)
}

describe('BashService', () => {
  let service: BashService
  let events: RecordedEvent[]
  let tmpCwd: string

  beforeEach(() => {
    service = new BashService()
    events = []
    service.setMainWindow(createMockWindow(events) as unknown as Parameters<
      BashService['setMainWindow']
    >[0])
    tmpCwd = fs.mkdtempSync(`${os.tmpdir()}/bash-svc-test-`)
  })

  afterEach(() => {
    service.killAll()
    try {
      fs.rmSync(tmpCwd, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('runs a basic command, emits start/output/end and returns exitCode 0', async () => {
    const sessionId = 's1'
    const result = await service.run(sessionId, 'echo hello', tmpCwd)

    expect(result.runId).toBeDefined()
    expect(result.runId.length).toBeGreaterThan(0)

    const end = await waitForEnd(events, sessionId, 5000)
    expect(end.status).toBe('exited')
    expect(end.exitCode).toBe(0)

    const sessionEvents = eventsForSession(events, sessionId)
    const startEvent = sessionEvents.find(
      (e): e is Extract<BashStreamEvent, { type: 'start' }> => e.type === 'start'
    )
    expect(startEvent).toBeDefined()
    expect(startEvent?.command).toBe('echo hello')
    expect(startEvent?.cwd).toBe(tmpCwd)
    expect(startEvent?.runId).toBe(result.runId)

    const outputEvents = sessionEvents.filter(
      (e): e is Extract<BashStreamEvent, { type: 'output' }> => e.type === 'output'
    )
    expect(outputEvents.length).toBeGreaterThan(0)
    expect(joinedOutput(sessionEvents)).toContain('hello')
  })

  it('merges stderr with stdout in output events', async () => {
    const sessionId = 's2'
    await service.run(sessionId, 'echo OUT; echo ERR 1>&2', tmpCwd)

    const end = await waitForEnd(events, sessionId, 5000)
    expect(end.status).toBe('exited')

    const combined = joinedOutput(eventsForSession(events, sessionId))
    expect(combined).toContain('OUT')
    expect(combined).toContain('ERR')
  })

  it('rejects a concurrent run for the same session', async () => {
    const sessionId = 's-concurrent'
    // Use a slow-finishing command so the first run is still running.
    await service.run(sessionId, 'sleep 2', tmpCwd)

    await expect(service.run(sessionId, 'echo nope', tmpCwd)).rejects.toThrow(
      /already running/i
    )

    // Tear down the slow run so the test exits cleanly.
    await service.abort(sessionId)
    await waitForEnd(events, sessionId, 5000)
  })

  it('runs different sessions concurrently without leaking events', async () => {
    const a = 'sess-a'
    const b = 'sess-b'

    await Promise.all([
      service.run(a, 'echo aaa; sleep 0.2; echo aaa-end', tmpCwd),
      service.run(b, 'echo bbb; sleep 0.2; echo bbb-end', tmpCwd)
    ])

    const endA = await waitForEnd(events, a, 5000)
    const endB = await waitForEnd(events, b, 5000)
    expect(endA.status).toBe('exited')
    expect(endB.status).toBe('exited')

    const aEvents = eventsForSession(events, a)
    const bEvents = eventsForSession(events, b)

    const aOutput = joinedOutput(aEvents)
    const bOutput = joinedOutput(bEvents)

    expect(aOutput).toContain('aaa')
    expect(aOutput).not.toContain('bbb')
    expect(bOutput).toContain('bbb')
    expect(bOutput).not.toContain('aaa')
  })

  it('aborts a running command (SIGTERM, escalates to SIGKILL after 2s)', async () => {
    const sessionId = 's-abort'
    await service.run(sessionId, 'sleep 5', tmpCwd)

    const aborted = await service.abort(sessionId)
    expect(aborted).toBe(true)

    const end = await waitForEnd(events, sessionId, 4000)
    expect(end.status).toBe('killed')
  }, 10_000)

  it('truncates output at 1 MB and ends with truncated status', async () => {
    const sessionId = 's-trunc'
    // Generate ~2 MB of stdout quickly.
    await service.run(sessionId, "head -c 2000000 /dev/zero | tr '\\0' 'A'", tmpCwd)

    const end = await waitForEnd(events, sessionId, 10_000)
    expect(end.status).toBe('truncated')

    const snapshot = service.getRun(sessionId)
    expect(snapshot).toBeTruthy()
    expect(snapshot?.outputBuffer).toContain('[output truncated at 1 MB')
  }, 15_000)

  it('getRun returns a live snapshot during run and a final snapshot after end (without proc)', async () => {
    const sessionId = 's-snap'
    await service.run(sessionId, "echo first; sleep 0.4; echo second", tmpCwd)

    // Live snapshot — status should be running.
    const live = service.getRun(sessionId)
    expect(live).toBeTruthy()
    expect(live?.status).toBe('running')
    expect(Object.prototype.hasOwnProperty.call(live ?? {}, 'proc')).toBe(false)

    const end = await waitForEnd(events, sessionId, 5000)
    expect(end.status).toBe('exited')

    const finalSnap = service.getRun(sessionId)
    expect(finalSnap).toBeTruthy()
    expect(finalSnap?.status).toBe('exited')
    expect(finalSnap?.exitCode).toBe(0)
    expect(finalSnap?.outputBuffer).toContain('first')
    expect(finalSnap?.outputBuffer).toContain('second')
    expect(Object.prototype.hasOwnProperty.call(finalSnap ?? {}, 'proc')).toBe(false)
  })
})
