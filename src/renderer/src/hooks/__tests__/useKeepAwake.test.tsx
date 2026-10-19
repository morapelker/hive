import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useKeepAwake } from '../useKeepAwake'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

const systemApiMocks = vi.hoisted(() => ({
  setKeepAwake: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/api/system-api', () => ({
  systemApi: systemApiMocks
}))

const busyRun = makeDetail({ id: 'run-busy', status: 'running' }, [
  { key: 'A', status: 'merged' },
  { key: 'B', status: 'verifying' }
])
const waitingRun = makeDetail({ id: 'run-waiting', status: 'running' }, [
  { key: 'A', status: 'needs_input' },
  { key: 'B', status: 'pending', depends_on: ['A'] }
])
const waitingMidMergeRun = makeDetail({ id: 'run-waiting-merge', status: 'running' }, [
  { key: 'A', status: 'merged' },
  { key: 'B', status: 'resolving_conflicts', status_detail: 'Waiting for you: Keep both?' }
])

describe('useKeepAwake', () => {
  const initialSettingsState = useSettingsStore.getState()
  const initialStatusState = useWorktreeStatusStore.getState()
  const initialDocumentFlowState = useDocumentFlowStore.getState()

  const lastCall = (): boolean | undefined => systemApiMocks.setKeepAwake.mock.lastCall?.[0]

  beforeEach(() => {
    useSettingsStore.setState({ ...initialSettingsState, keepAwakeEnabled: true }, true)
    useWorktreeStatusStore.setState({ ...initialStatusState, sessionStatuses: {} }, true)
    useDocumentFlowStore.setState({ ...initialDocumentFlowState, runsById: {} }, true)
    useKanbanStore.setState({ tickets: new Map() })
    systemApiMocks.setKeepAwake.mockClear()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useDocumentFlowStore.setState(initialDocumentFlowState, true)
  })

  it('keeps the machine awake while a session is paused behind a pending monitor', () => {
    renderHook(() => useKeepAwake())
    expect(lastCall()).toBe(false)

    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { paused: { status: 'completed', timestamp: 1, completion: 'waiting' } }
      })
    })
    expect(lastCall()).toBe(true)

    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { paused: { status: 'completed', timestamp: 2, completion: 'completed' } }
      })
    })
    expect(lastCall()).toBe(false)
  })

  it('keeps the machine awake while a stopped session sits on an in-progress ticket', () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { sess: { status: 'completed', timestamp: 1 } }
    })
    useKanbanStore.setState({
      tickets: new Map([
        [
          'proj',
          [
            {
              id: 'ticket',
              column: 'in_progress',
              current_session_id: 'sess',
              worktree_id: null,
              archived_at: null
            } as unknown as KanbanTicket
          ]
        ]
      ])
    })

    renderHook(() => useKeepAwake())
    expect(lastCall()).toBe(true)

    act(() => {
      useKanbanStore.setState({ tickets: new Map() })
    })
    expect(lastCall()).toBe(false)
  })

  it('keeps the machine awake while a document run works between sessions', () => {
    renderHook(() => useKeepAwake())
    expect(lastCall()).toBe(false)

    act(() => {
      useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })
    })
    expect(lastCall()).toBe(true)

    act(() => {
      useDocumentFlowStore.setState({ runsById: {} })
    })
    expect(lastCall()).toBe(false)
  })

  it('lets the machine sleep when the run only waits on the user', () => {
    useDocumentFlowStore.setState({ runsById: { [waitingRun.run.id]: waitingRun } })

    renderHook(() => useKeepAwake())

    expect(lastCall()).toBe(false)
  })

  it('lets the machine sleep while a conflict session, mid-merge, waits on the user', () => {
    useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })

    renderHook(() => useKeepAwake())
    expect(lastCall()).toBe(true)

    act(() => {
      useDocumentFlowStore.setState({
        runsById: { [waitingMidMergeRun.run.id]: waitingMidMergeRun }
      })
    })
    expect(lastCall()).toBe(false)
  })

  it('still follows streaming sessions', () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { session1: { status: 'working', timestamp: Date.now() } }
    })

    renderHook(() => useKeepAwake())

    expect(lastCall()).toBe(true)
  })

  it('respects the keep-awake setting even with a busy run', () => {
    useSettingsStore.setState({ keepAwakeEnabled: false })
    useDocumentFlowStore.setState({ runsById: { [busyRun.run.id]: busyRun } })

    renderHook(() => useKeepAwake())

    expect(lastCall()).toBe(false)
  })
})
