import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  onShellCommandStatus: vi.fn(),
  unsubscribe: vi.fn(),
  loadAll: vi.fn(async () => {}),
  applyShellCommandRunStatus: vi.fn(),
  markRunningShellCommandsWorking: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: { onShellCommandStatus: mocks.onShellCommandStatus }
}))

vi.mock('@/stores/useShellCommandRunStore', () => ({
  useShellCommandRunStore: { getState: () => ({ loadAll: mocks.loadAll }) }
}))

vi.mock('@/lib/shell-command-status', () => ({
  applyShellCommandRunStatus: mocks.applyShellCommandRunStatus,
  markRunningShellCommandsWorking: mocks.markRunningShellCommandsWorking
}))

import { useShellCommandStatusListener } from '../useShellCommandStatusListener'

const payload = {
  sessionId: 'session-1',
  runId: 'run-1',
  state: 'running' as const,
  exitCode: null,
  signal: null,
  detached: false,
  reason: null,
  error: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null
}

describe('useShellCommandStatusListener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onShellCommandStatus.mockReturnValue(mocks.unsubscribe)
  })

  it('subscribes once and loads the run index on mount', () => {
    const { rerender } = renderHook(() => useShellCommandStatusListener())
    rerender()

    expect(mocks.onShellCommandStatus).toHaveBeenCalledTimes(1)
    expect(mocks.loadAll).toHaveBeenCalledTimes(1)
  })

  it('seeds the working status of already-running runs once the index has loaded', async () => {
    renderHook(() => useShellCommandStatusListener())
    expect(mocks.markRunningShellCommandsWorking).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(mocks.markRunningShellCommandsWorking).toHaveBeenCalledTimes(1))
  })

  it('keeps the subscription when loading the index fails', async () => {
    mocks.loadAll.mockRejectedValueOnce(new Error('offline'))
    renderHook(() => useShellCommandStatusListener())

    await Promise.resolve()
    expect(mocks.onShellCommandStatus).toHaveBeenCalledTimes(1)
    expect(mocks.markRunningShellCommandsWorking).not.toHaveBeenCalled()
  })

  it('forwards payloads to applyShellCommandRunStatus', () => {
    renderHook(() => useShellCommandStatusListener())

    const callback = mocks.onShellCommandStatus.mock.calls[0]?.[0] as (p: unknown) => void
    callback(payload)

    expect(mocks.applyShellCommandRunStatus).toHaveBeenCalledExactlyOnceWith(payload)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useShellCommandStatusListener())
    expect(mocks.unsubscribe).not.toHaveBeenCalled()

    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
