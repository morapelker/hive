import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { createLiveRunnerPorts } from './runner-ports'

// The live notice port: a run made from board tickets titles its system notification as an
// orchestrator; a document run's notices keep the title they always had. And the live link port:
// a session that is over loses its link to the ticket, and the ticket loses nothing else.

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

const mocks = vi.hoisted(() => ({
  showNotification: vi.fn(async () => undefined),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))

vi.mock('@/api/system-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/system-api')>()
  return {
    ...original,
    systemApi: { ...original.systemApi, showNotification: mocks.showNotification }
  }
})

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))

describe('createLiveRunnerPorts().notify', () => {
  beforeEach(() => {
    mocks.showNotification.mockClear()
    mocks.toast.success.mockClear()
  })

  it('titles the notification with the kind of run the notice names', () => {
    createLiveRunnerPorts().notify({
      level: 'success',
      message: 'Orchestrator finished: 2 merged',
      title: 'Orchestrator'
    })

    expect(mocks.toast.success).toHaveBeenCalledWith('Orchestrator finished: 2 merged')
    expect(mocks.showNotification).toHaveBeenCalledWith({
      title: 'Orchestrator',
      body: 'Orchestrator finished: 2 merged'
    })
  })

  it('keeps "Document run" for a notice that names no kind', () => {
    createLiveRunnerPorts().notify({ level: 'success', message: 'Document run finished: 1 merged' })

    expect(mocks.showNotification).toHaveBeenCalledWith({
      title: 'Document run',
      body: 'Document run finished: 1 merged'
    })
  })
})

describe('createLiveRunnerPorts().unlinkTicketSession', () => {
  const initial = useKanbanStore.getState()

  afterEach(() => {
    useKanbanStore.setState(initial, true)
  })

  it('writes the link and nothing else, so the ticket stays where the user left it', async () => {
    const updateTicket = vi.fn(async () => {})
    useKanbanStore.setState({ updateTicket })

    await createLiveRunnerPorts().unlinkTicketSession('project-1', 'ticket-1')

    expect(updateTicket).toHaveBeenCalledExactlyOnceWith('ticket-1', 'project-1', {
      current_session_id: null
    })
  })

  it('rejects when the write fails, for the launch not to go ahead', async () => {
    useKanbanStore.setState({ updateTicket: vi.fn().mockRejectedValue(new Error('no')) })

    await expect(
      createLiveRunnerPorts().unlinkTicketSession('project-1', 'ticket-1')
    ).rejects.toThrow('no')
  })
})
