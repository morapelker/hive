import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLiveKanbanRpcService } from '../rpc/domains/kanban'

const mocks = vi.hoisted(() => ({
  backend: {
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    archive: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    removeAllDependencies: vi.fn()
  },
  moveKanbanTicketToProject: vi.fn(),
  service: {
    onBoardTicketChanged: vi.fn(),
    onBoardDependenciesChanged: vi.fn(),
    deleteRunTicket: vi.fn()
  },
  liveDocumentFlowService: vi.fn(),
  getDocumentFlowService: vi.fn()
}))

vi.mock('../../main/services/kanban-backend', () => ({
  getKanbanBackendForProject: () => mocks.backend,
  moveKanbanTicketToProject: mocks.moveKanbanTicketToProject
}))

vi.mock('../../main/services/document-flow/document-flow-service', () => ({
  liveDocumentFlowService: mocks.liveDocumentFlowService,
  getDocumentFlowService: mocks.getDocumentFlowService
}))

const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(effect)

// An orchestrator made from board tickets follows the board: the kanban calls that change a
// ticket it copies (title, description), take one off the board, or change the dependencies
// between its tickets tell the running document flow service, after the board change and
// without ever failing it. A board change does not start the service.
describe('live kanban service: telling orchestrators about board changes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.liveDocumentFlowService.mockReturnValue(mocks.service)
    mocks.service.onBoardTicketChanged.mockResolvedValue(undefined)
    mocks.service.onBoardDependenciesChanged.mockResolvedValue(undefined)
    mocks.backend.update.mockResolvedValue({ id: 'ticket-1' })
    mocks.backend.get.mockResolvedValue({ id: 'ticket-1', external_provider: null })
    mocks.backend.delete.mockResolvedValue(true)
    mocks.backend.archive.mockResolvedValue({ id: 'ticket-1', external_provider: null })
    mocks.backend.addDependency.mockResolvedValue({ success: true })
    mocks.backend.removeDependency.mockResolvedValue(true)
    mocks.backend.removeAllDependencies.mockResolvedValue(2)
    mocks.moveKanbanTicketToProject.mockResolvedValue({ id: 'ticket-1' })
  })

  it('follows a title or description edit, after the board took it', async () => {
    const kanban = makeLiveKanbanRpcService()
    mocks.service.onBoardTicketChanged.mockImplementation(async () => {
      expect(mocks.backend.update).toHaveBeenCalled()
    })

    await expect(
      run(kanban.updateTicket('project-1', 'ticket-1', { title: 'New title' }))
    ).resolves.toEqual({ id: 'ticket-1' })
    await run(kanban.updateTicket('project-1', 'ticket-1', { description: null }))

    expect(mocks.service.onBoardTicketChanged.mock.calls).toEqual([
      ['project-1', 'ticket-1'],
      ['project-1', 'ticket-1']
    ])
  })

  it('ignores an edit that changes nothing an orchestrator copies', async () => {
    await run(makeLiveKanbanRpcService().updateTicket('project-1', 'ticket-1', { mark: 'epic' }))

    expect(mocks.backend.update).toHaveBeenCalledWith('project-1', 'ticket-1', { mark: 'epic' })
    expect(mocks.service.onBoardTicketChanged).not.toHaveBeenCalled()
  })

  it('follows a ticket that left the board: deleted, archived or moved to another project', async () => {
    const kanban = makeLiveKanbanRpcService()

    await expect(run(kanban.deleteTicket('project-1', 'ticket-1'))).resolves.toBe(true)
    await run(kanban.archiveTicket('project-1', 'ticket-2'))
    await run(kanban.moveTicketToProject?.('project-1', 'ticket-3', 'project-2') as never)

    expect(mocks.service.onBoardTicketChanged.mock.calls).toEqual([
      ['project-1', 'ticket-1'],
      ['project-1', 'ticket-2'],
      ['project-1', 'ticket-3']
    ])
  })

  it("leaves the ticket of a run alone: archiving it is the run's business", async () => {
    mocks.backend.archive.mockResolvedValue({
      id: 'ticket-run',
      external_provider: 'document-run',
      external_id: 'run-1'
    })

    await run(makeLiveKanbanRpcService().archiveTicket('project-1', 'ticket-run'))

    expect(mocks.service.onBoardTicketChanged).not.toHaveBeenCalled()
  })

  it('follows every dependency change, naming both tickets of an edge', async () => {
    const kanban = makeLiveKanbanRpcService()

    await expect(
      run(kanban.addTicketDependency?.('project-1', 'ticket-2', 'ticket-1') as never)
    ).resolves.toEqual({ success: true })
    await run(kanban.removeTicketDependency?.('project-1', 'ticket-2', 'ticket-1') as never)
    await run(kanban.removeAllDependenciesForTicket?.('project-1', 'ticket-3') as never)

    expect(mocks.service.onBoardDependenciesChanged.mock.calls).toEqual([
      ['project-1', ['ticket-2', 'ticket-1']],
      ['project-1', ['ticket-2', 'ticket-1']],
      ['project-1', ['ticket-3']]
    ])
  })

  it('never fails the board change, and does not start a service that is not running', async () => {
    const kanban = makeLiveKanbanRpcService()
    mocks.service.onBoardTicketChanged.mockRejectedValue(new Error('the run is gone'))
    mocks.service.onBoardDependenciesChanged.mockRejectedValue(new Error('the run is gone'))

    await expect(
      run(kanban.updateTicket('project-1', 'ticket-1', { title: 'x' }))
    ).resolves.toEqual({ id: 'ticket-1' })
    await expect(
      run(kanban.addTicketDependency?.('project-1', 'ticket-2', 'ticket-1') as never)
    ).resolves.toEqual({ success: true })

    vi.clearAllMocks()
    mocks.liveDocumentFlowService.mockReturnValue(null)
    await expect(run(kanban.deleteTicket('project-1', 'ticket-1'))).resolves.toBe(true)
    expect(mocks.liveDocumentFlowService).toHaveBeenCalled()
    expect(mocks.getDocumentFlowService).not.toHaveBeenCalled()
    expect(mocks.service.onBoardTicketChanged).not.toHaveBeenCalled()
  })
})
