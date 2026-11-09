import { beforeEach, describe, expect, it, vi } from 'vitest'

const gates = vi.hoisted(() => ({
  isMigrationSession: vi.fn(() => false),
  isManualStepsSession: vi.fn(() => false)
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: { ticket: { getBySession: vi.fn().mockResolvedValue([]) } }
}))
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ automaticallyCreateTicket: true }) }
}))
vi.mock('./useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      getSessionById: () => ({
        id: 'session-1',
        project_id: 'project-1',
        worktree_id: 'wt-1',
        connection_id: null,
        mode: 'build',
        agent_sdk: 'claude-code-cli',
        session_type: null
      })
    })
  }
}))
vi.mock('@/lib/document-flow/migrations', () => ({
  isMigrationSession: gates.isMigrationSession
}))
vi.mock('@/lib/document-flow/manual-steps', () => ({
  isManualStepsSession: gates.isManualStepsSession
}))
vi.mock('@/lib/auto-pin', () => ({ autoPinForBoardPrompt: vi.fn() }))

import { useKanbanStore } from './useKanbanStore'
import { notifyKanbanAutoCreateTicket } from './store-coordination'

const flush = async (): Promise<void> => {
  // The callback awaits a few dynamic imports before it reaches its gates.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('the board’s automatic ticket for a session', () => {
  const createTicket = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    createTicket.mockClear()
    gates.isMigrationSession.mockReturnValue(false)
    gates.isManualStepsSession.mockReturnValue(false)
    useKanbanStore.setState({ createTicket } as never)
  })

  it('opens one for an ordinary session', async () => {
    notifyKanbanAutoCreateTicket({ sessionId: 'session-1', rawPrompt: 'fix the bug' })
    await flush()
    expect(createTicket).toHaveBeenCalledTimes(1)
  })

  it('does not for a session executing a run’s manual steps', async () => {
    gates.isManualStepsSession.mockReturnValue(true)
    notifyKanbanAutoCreateTicket({ sessionId: 'session-1', rawPrompt: 'do the steps' })
    await flush()
    expect(gates.isManualStepsSession).toHaveBeenCalledWith('session-1')
    expect(createTicket).not.toHaveBeenCalled()
  })

  it('does not for a session executing a run’s migrations', async () => {
    gates.isMigrationSession.mockReturnValue(true)
    notifyKanbanAutoCreateTicket({ sessionId: 'session-1', rawPrompt: 'migrate' })
    await flush()
    expect(createTicket).not.toHaveBeenCalled()
  })
})
