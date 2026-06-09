import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeEventBus } from '../../../events/event-bus'
import type { ServerEvent } from '../../../../shared/rpc/protocol'
import { scriptRunner } from '../../../../main/services/script-runner'
import { makeLiveScriptOpsRpcService } from '../script-ops'

vi.mock('../../../../main/db', () => ({
  getDatabase: () => ({
    getWorktree: () => null
  })
}))

vi.mock('../../../../main/desktop/backend-manager', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

const tempDirs: string[] = []
const unsubscribes: Array<() => void> = []

afterEach(() => {
  scriptRunner.setEventPublisher(null)
  scriptRunner.killAll()

  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe()
  }

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('scriptOps live RPC service', () => {
  it('runs setup scripts through the backend runner and publishes setup output events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hive-script-setup-'))
    tempDirs.push(cwd)
    const eventBus = makeEventBus()
    const channel = 'script:setup:worktree-setup'
    const events: ServerEvent[] = []
    const unsubscribe = await Effect.runPromise(
      eventBus.subscribe(channel, (event) => {
        events.push(event)
      })
    )
    unsubscribes.push(unsubscribe)
    const service = makeLiveScriptOpsRpcService(eventBus)

    await expect(
      Effect.runPromise(service.runSetup(['printf setup-output'], cwd, 'worktree-setup'))
    ).resolves.toEqual({ success: true })

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        channel,
        payload: { type: 'command-start', command: 'printf setup-output' }
      })
      expect(events).toContainEqual({
        channel,
        payload: { type: 'output', data: 'setup-output' }
      })
      expect(events).toContainEqual({
        channel,
        payload: { type: 'done' }
      })
    })
  })

  it('runs project scripts through the backend runner and publishes run output events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hive-script-run-'))
    tempDirs.push(cwd)
    const eventBus = makeEventBus()
    const channel = 'script:run:worktree-run'
    const events: ServerEvent[] = []
    const unsubscribe = await Effect.runPromise(
      eventBus.subscribe(channel, (event) => {
        events.push(event)
      })
    )
    unsubscribes.push(unsubscribe)
    const service = makeLiveScriptOpsRpcService(eventBus)

    const result = await Effect.runPromise(
      service.runProject(['printf run-output; sleep 5'], cwd, 'worktree-run')
    )

    expect(result.success).toBe(true)
    expect(result.pid).toEqual(expect.any(Number))
    expect(result.pid).toBeGreaterThan(0)
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        channel,
        payload: { type: 'output', data: 'run-output' }
      })
    })
  })

  it('runs archive scripts through the backend runner and returns captured output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hive-script-archive-'))
    tempDirs.push(cwd)
    const service = makeLiveScriptOpsRpcService(makeEventBus())

    await expect(
      Effect.runPromise(
        service.runArchive(
          ['printf archive-output', 'printf "\\narchive-error\\n" >&2'],
          cwd
        )
      )
    ).resolves.toEqual({
      success: true,
      output: 'archive-output\narchive-error\n'
    })
  })

  it('kills backend-owned run scripts before using the desktop fallback', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hive-script-kill-'))
    tempDirs.push(cwd)
    const service = makeLiveScriptOpsRpcService(makeEventBus())
    const originalSend = process.send
    const desktopSend = vi.fn()

    Object.defineProperty(process, 'send', {
      configurable: true,
      value: desktopSend
    })

    try {
      await expect(
        Effect.runPromise(service.runProject(['sleep 30'], cwd, 'worktree-kill'))
      ).resolves.toMatchObject({ success: true, pid: expect.any(Number) })
      expect(scriptRunner.getStats().active).toBeGreaterThan(0)

      await expect(Effect.runPromise(service.kill('worktree-kill'))).resolves.toEqual({
        success: true
      })

      expect(scriptRunner.getStats().active).toBe(0)
      expect(desktopSend).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'send', {
        configurable: true,
        value: originalSend
      })
    }
  })
})
