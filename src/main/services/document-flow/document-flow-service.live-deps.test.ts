// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDiagnostics: vi.fn(),
  unarchive: vi.fn(),
  getKanbanBackendForProject: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({ getSession: mocks.getSession, listDocumentRuns: () => [] })
}))

vi.mock('../kanban-backend', () => ({
  getKanbanBackendForProject: mocks.getKanbanBackendForProject,
  getMarkdownKanbanBackend: () => ({ getDiagnostics: mocks.getDiagnostics })
}))

import { getDocumentFlowService, type DocumentFlowServiceDeps } from './document-flow-service'

// The process-wide service as `getDocumentFlowService` wires it to the board and the database:
// the suites that use the harness replace these collaborators, so this is where their real
// wiring is checked.

const liveDeps = async (): Promise<DocumentFlowServiceDeps> => {
  const service = await getDocumentFlowService()
  return (service as unknown as { deps: DocumentFlowServiceDeps }).deps
}

const diagnostic = (blocking: boolean): { blocking: boolean } => ({ blocking })

describe('the live wiring of a run made from board tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getKanbanBackendForProject.mockReturnValue({ unarchive: mocks.unarchive })
  })

  it('calls a board unreadable on a blocking diagnostic of its markdown backend only', async () => {
    const deps = await liveDeps()

    mocks.getDiagnostics.mockResolvedValue([])
    await expect(deps.boardHasUnreadableCards?.('project-1')).resolves.toBe(false)
    expect(mocks.getDiagnostics).toHaveBeenCalledWith('project-1')

    mocks.getDiagnostics.mockResolvedValue([diagnostic(false)])
    await expect(deps.boardHasUnreadableCards?.('project-1')).resolves.toBe(false)

    mocks.getDiagnostics.mockResolvedValue([diagnostic(false), diagnostic(true)])
    await expect(deps.boardHasUnreadableCards?.('project-1')).resolves.toBe(true)
  })

  it.each([
    ['active', true],
    ['completed', false],
    ['error', false]
  ])("reads a session's row: %s is active: %s", async (status, active) => {
    const deps = await liveDeps()
    mocks.getSession.mockReturnValue({ id: 'session-1', status })

    expect(deps.isSessionActive?.('session-1')).toBe(active)
    expect(mocks.getSession).toHaveBeenCalledWith('session-1')
  })

  it('takes a session with no row for one that is no longer active', async () => {
    const deps = await liveDeps()
    mocks.getSession.mockReturnValue(null)

    expect(deps.isSessionActive?.('session-1')).toBe(false)
  })

  it('unarchives through the backend of the project, as the board does', async () => {
    const deps = await liveDeps()

    await deps.unarchiveTicket('project-1', 'ticket-1')

    expect(mocks.getKanbanBackendForProject).toHaveBeenCalledWith('project-1')
    expect(mocks.unarchive).toHaveBeenCalledWith('project-1', 'ticket-1')
  })
})
