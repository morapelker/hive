import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDocumentFlowRunner } from '../useDocumentFlowRunner'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { DocumentFlowRunner } from '@/lib/document-flow/runner'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'

const mocks = vi.hoisted(() => ({
  onUpdated: vi.fn(),
  unsubscribeUpdated: vi.fn(),
  list: vi.fn(),
  runnerStart: vi.fn(),
  runnerStop: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({
  documentFlowApi: {
    onUpdated: mocks.onUpdated,
    list: mocks.list
  }
}))

vi.mock('@/lib/document-flow/runner-ports', () => ({
  createLiveRunnerPorts: vi.fn(() => ({ fake: true }))
}))

vi.mock('@/lib/document-flow/runner', () => ({
  DocumentFlowRunner: vi.fn(function FakeRunner() {
    return { start: mocks.runnerStart, stop: mocks.runnerStop }
  })
}))

describe('useDocumentFlowRunner', () => {
  const initialState = useDocumentFlowStore.getState()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onUpdated.mockReturnValue(mocks.unsubscribeUpdated)
    mocks.list.mockResolvedValue([])
    useDocumentFlowStore.setState({ ...initialState, runsById: {} }, true)
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
    useDocumentFlowStore.setState(initialState, true)
  })

  it('subscribes to pushes, loads the runs, and drives them until unmounted', async () => {
    const handleUpdated = vi.fn()
    useDocumentFlowStore.setState({ handleUpdated })
    const onOpen = vi.fn((_listener: () => void) => vi.fn())
    setRendererRpcClient({ request: vi.fn(), subscribe: vi.fn(), onOpen } as never)

    const { unmount } = renderHook(() => useDocumentFlowRunner())

    expect(mocks.onUpdated).toHaveBeenCalledTimes(1)
    const push = mocks.onUpdated.mock.calls[0][0] as (event: unknown) => void
    push({ runId: 'run-1', projectId: 'project-1', reason: 'item' })
    expect(handleUpdated).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'project-1',
      reason: 'item'
    })
    expect(mocks.list).toHaveBeenCalledWith(undefined)
    expect(DocumentFlowRunner).toHaveBeenCalledWith({ fake: true })
    expect(mocks.runnerStart).toHaveBeenCalledTimes(1)

    // A reconnect re-reads the runs: pushes sent meanwhile were lost.
    expect(onOpen).toHaveBeenCalledTimes(1)
    const reconnected = onOpen.mock.calls[0][0]
    reconnected()
    expect(mocks.list).toHaveBeenCalledTimes(2)

    unmount()
    expect(mocks.runnerStop).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribeUpdated).toHaveBeenCalledTimes(1)
  })

  it('still loads and drives runs when the RPC client cannot subscribe', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.onUpdated.mockImplementation(() => {
      throw new Error('Renderer RPC client has not been initialized')
    })

    const { unmount } = renderHook(() => useDocumentFlowRunner())

    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.runnerStart).toHaveBeenCalledTimes(1)

    unmount()
    expect(mocks.runnerStop).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
