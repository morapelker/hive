import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLiveKanbanRpcService } from '../rpc/domains/kanban'

const mocks = vi.hoisted(() => ({
  backend: { get: vi.fn(), delete: vi.fn() },
  service: { deleteRunTicket: vi.fn() },
  getDocumentFlowService: vi.fn()
}))

vi.mock('../../main/services/kanban-backend', () => ({
  getKanbanBackendForProject: () => mocks.backend
}))

vi.mock('../../main/services/document-flow/document-flow-service', () => ({
  getDocumentFlowService: mocks.getDocumentFlowService
}))

// Deleting a ticket over RPC, from whichever client: the ticket of a document run goes through
// the run's service, which refuses while the run is going and removes the run with it.
describe('live kanban service: deleting the ticket of a document run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDocumentFlowService.mockResolvedValue(mocks.service)
    mocks.backend.delete.mockResolvedValue(true)
    mocks.service.deleteRunTicket.mockResolvedValue(true)
  })

  it('hands the ticket of a run to the document flow service', async () => {
    mocks.backend.get.mockResolvedValue({
      id: 'ticket-run',
      external_provider: 'document-run',
      external_id: 'run-1'
    })

    const deleted = await Effect.runPromise(
      makeLiveKanbanRpcService().deleteTicket('project-1', 'ticket-run')
    )

    expect(deleted).toBe(true)
    expect(mocks.service.deleteRunTicket).toHaveBeenCalledWith('project-1', 'ticket-run', 'run-1')
    expect(mocks.backend.delete).not.toHaveBeenCalled()
  })

  it('passes on the refusal for a run that is still going, and deletes nothing', async () => {
    mocks.backend.get.mockResolvedValue({
      id: 'ticket-run',
      external_provider: 'document-run',
      external_id: 'run-1'
    })
    mocks.service.deleteRunTicket.mockRejectedValue(
      new Error('Cancel the run before deleting its ticket.')
    )

    await expect(
      Effect.runPromise(makeLiveKanbanRpcService().deleteTicket('project-1', 'ticket-run'))
    ).rejects.toThrow('Cancel the run before deleting its ticket.')
    expect(mocks.backend.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['an ordinary ticket', { id: 'ticket-1', external_provider: null, external_id: null }],
    ['an imported ticket', { id: 'ticket-1', external_provider: 'github', external_id: '42' }],
    ['a ticket that is already gone', null]
  ])('deletes %s through the board backend alone', async (_name, ticket) => {
    mocks.backend.get.mockResolvedValue(ticket)

    await Effect.runPromise(makeLiveKanbanRpcService().deleteTicket('project-1', 'ticket-1'))

    expect(mocks.backend.delete).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(mocks.getDocumentFlowService).not.toHaveBeenCalled()
  })
})
