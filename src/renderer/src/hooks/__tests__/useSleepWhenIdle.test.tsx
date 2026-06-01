import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSleepWhenIdle } from '../useSleepWhenIdle'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSleepWhenIdleStore } from '@/stores/useSleepWhenIdleStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

const systemApiMocks = vi.hoisted(() => ({
  sleepNow: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/api/system-api', () => ({
  systemApi: systemApiMocks
}))

describe('useSleepWhenIdle', () => {
  const initialSettingsState = useSettingsStore.getState()
  const initialStatusState = useWorktreeStatusStore.getState()

  beforeEach(() => {
    vi.useFakeTimers()
    useSettingsStore.setState({ ...initialSettingsState, keepAwakeEnabled: true }, true)
    useWorktreeStatusStore.setState({ ...initialStatusState, sessionStatuses: {} }, true)
    useSleepWhenIdleStore.setState({ armed: true })
    systemApiMocks.sleepNow.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useSleepWhenIdleStore.setState({ armed: false })
    systemApiMocks.sleepNow.mockClear()
  })

  it('sleeps once after all sessions have been idle for one continuous minute', async () => {
    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(systemApiMocks.sleepNow).toHaveBeenCalledTimes(1)
    expect(useSleepWhenIdleStore.getState().armed).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(systemApiMocks.sleepNow).toHaveBeenCalledTimes(1)
  })

  it('resets the idle timer when work resumes before the debounce expires', async () => {
    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
      useWorktreeStatusStore.setState({
        sessionStatuses: { session1: { status: 'working', timestamp: Date.now() } }
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()
    expect(useSleepWhenIdleStore.getState().armed).toBe(true)

    await act(async () => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { session1: { status: 'completed', timestamp: Date.now() } }
      })
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

  it('does not sleep while a session is waiting on user approval', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { session1: { status: 'permission', timestamp: Date.now() } }
    })

    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()
    expect(useSleepWhenIdleStore.getState().armed).toBe(true)
  })

  it('disarms without sleeping when keep awake is disabled', async () => {
    renderHook(() => useSleepWhenIdle())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
      useSettingsStore.setState({ keepAwakeEnabled: false })
    })

    expect(useSleepWhenIdleStore.getState().armed).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(systemApiMocks.sleepNow).not.toHaveBeenCalled()
  })
})
