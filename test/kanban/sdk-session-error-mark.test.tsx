import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: { get: vi.fn(), set: vi.fn() },
    session: { get: vi.fn() }
  },
  opencodeApi: { onStream: vi.fn() },
  settingsApi: { onSettingsUpdated: vi.fn() },
  worktreeApi: { onBranchRenamed: vi.fn(), onWorktreeCreated: vi.fn() },
  notifyKanbanSessionSync: vi.fn()
}))

vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/worktree-api', () => ({ worktreeApi: apiMocks.worktreeApi }))
vi.mock('@/stores/store-coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/store-coordination')>()),
  notifyKanbanSessionSync: apiMocks.notifyKanbanSessionSync
}))

describe('useOpenCodeGlobalListener SDK session error mark', () => {
  let streamListener: ((event: OpenCodeStreamEvent) => void) | null

  beforeEach(() => {
    streamListener = null
    vi.clearAllMocks()
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.dbApi.session.get.mockResolvedValue(null)
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.worktreeApi.onBranchRenamed.mockReturnValue(vi.fn())
    apiMocks.worktreeApi.onWorktreeCreated.mockReturnValue(vi.fn())
    apiMocks.opencodeApi.onStream.mockImplementation(
      (listener: (event: OpenCodeStreamEvent) => void) => {
        streamListener = listener
        return vi.fn()
      }
    )

    useSessionStore.setState({
      activeSessionId: null,
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useKanbanStore.setState({ isBoardViewActive: false } as Partial<
      ReturnType<typeof useKanbanStore.getState>
    >)
    useWorktreeStatusStore.setState({ sessionStatuses: {}, sessionApiErrors: {} })
  })

  afterEach(() => {
    cleanup()
  })

  async function mountListener(): Promise<void> {
    const { useOpenCodeGlobalListener } = await import('@/hooks/useOpenCodeGlobalListener')
    function ListenerHarness(): null {
      useOpenCodeGlobalListener()
      return null
    }
    render(<ListenerHarness />)
  }

  it('marks a background session errored and moves its ticket to review', async () => {
    await mountListener()

    streamListener?.({
      type: 'session.error',
      sessionId: 'session-1',
      data: { error: { message: 'Codex turn failed' } }
    })

    expect(useWorktreeStatusStore.getState().sessionApiErrors['session-1']).toBe(
      'Codex turn failed'
    )
    expect(apiMocks.notifyKanbanSessionSync).toHaveBeenCalledWith('session-1', {
      type: 'session_error'
    })
  })

  it('marks the active session errored but leaves the ticket move to SessionView', async () => {
    useSessionStore.setState({ activeSessionId: 'session-1' } as Partial<
      ReturnType<typeof useSessionStore.getState>
    >)
    await mountListener()

    streamListener?.({ type: 'session.error', sessionId: 'session-1', data: 'API overloaded' })

    expect(useWorktreeStatusStore.getState().sessionApiErrors['session-1']).toBe('API overloaded')
    expect(apiMocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
  })

  it('ignores errors from child (subagent) sessions', async () => {
    await mountListener()

    streamListener?.({
      type: 'session.error',
      sessionId: 'session-1',
      childSessionId: 'child-1',
      data: 'subagent failed'
    } as OpenCodeStreamEvent)

    expect(useWorktreeStatusStore.getState().sessionApiErrors['session-1']).toBeUndefined()
    expect(apiMocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
  })

  it('clears the mark once the session starts a new turn', async () => {
    useWorktreeStatusStore.setState({ sessionApiErrors: { 'session-1': 'boom' } })
    await mountListener()

    streamListener?.({
      type: 'session.status',
      sessionId: 'session-1',
      data: { status: { type: 'busy' } }
    })

    expect(useWorktreeStatusStore.getState().sessionApiErrors['session-1']).toBeUndefined()
  })
})
