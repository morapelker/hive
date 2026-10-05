import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSleepWhenIdle } from '../useSleepWhenIdle'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSleepWhenIdleStore } from '@/stores/useSleepWhenIdleStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

const systemApiMocks = vi.hoisted(() => ({
  sleepNow: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/api/system-api', () => ({
  systemApi: systemApiMocks
}))

const busyRun = makeDetail({ id: 'run-busy', status: 'running' }, [
  { key: 'A', status: 'merging' },
  { key: 'B', status: 'pending', depends_on: ['A'] }
])
const waitingRun = makeDetail({ id: 'run-waiting', status: 'running' }, [
  { key: 'A', status: 'needs_attention' }
])
const waitingFixRun = makeDetail({ id: 'run-waiting-fix', status: 'running' }, [
  {
    key: 'A',
    status: 'fixing',
    status_detail:
      'Waiting for you: you interrupted the fix session. Send it a message to continue.'
  }
])

describe('useSleepWhenIdle with document runs', () => {
  const initialSettingsState = useSettingsStore.getState()
  const initialStatusState = useWorktreeStatusStore.getState()
  const initialDocumentFlowState = useDocumentFlowStore.getState()

  beforeEach(() => {
    vi.useFakeTimers()
    useSettingsStore.setState({ ...initialSettingsState, keepAwakeEnabled: true }, true)
    useWorktreeStatusStore.setState({ ...initialStatusState, sessionStatuses: {} }, true)
    useDocumentFlowStore.setState({ ...initialDocumentFlowState, runsById: {} }, true)
    useSleepWhenIdleStore.setState({ armed: true })
    systemApiMocks.sleepNow.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useDocumentFlowStore.setState(initialDocumentFlowState, true)
    useSleepWhenIdleStore.setState({ armed: false })
    systemApiMocks.sleepNow.mockClear()
  })

  it('does not sleep while a document run works between sessions', async () => {
    useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })

    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })

    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()
    expect(useSleepWhenIdleStore.getState().armed).toBe(true)
  })

  it('starts the idle minute once the run finishes or waits on the user', async () => {
    useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })

    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
      useDocumentFlowStore.setState({ runsById: { [waitingRun.run.id]: waitingRun } })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(systemApiMocks.sleepNow).toHaveBeenCalledTimes(1)
  })

  it('starts the idle minute while a fix session, mid-merge, waits on the user', async () => {
    useDocumentFlowStore.setState({ runsById: { [waitingFixRun.run.id]: waitingFixRun } })

    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(systemApiMocks.sleepNow).toHaveBeenCalledTimes(1)
  })

  it('does not sleep when a run gets busy during the idle minute', async () => {
    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
      useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()
    expect(useSleepWhenIdleStore.getState().armed).toBe(true)
  })
})
