import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { KanbanRpcService } from '../rpc/domains/kanban'
import { makeRpcRouter } from '../rpc/router'

describe('kanban RPC mocked provider', () => {
  it('routes kanban.ticket.create to the injected provider service', async () => {
    const payload = {
      project_id: 'project-1',
      title: 'Ship HTTP migration',
      description: null,
      attachments: [{ name: 'notes.md', path: '/tmp/notes.md' }],
      column: 'todo' as const,
      sort_order: 10,
      current_session_id: null,
      worktree_id: 'worktree-1',
      mode: 'plan' as const,
      plan_ready: true,
      external_provider: 'github',
      external_id: '42',
      external_url: 'https://github.com/acme/hive/issues/42',
      github_pr_number: 17,
      github_pr_url: 'https://github.com/acme/hive/pull/17',
      mark: 'epic' as const
    }
    const ticket = {
      id: 'ticket-1',
      ...payload,
      created_at: '2026-05-31T07:00:00.000Z',
      updated_at: '2026-05-31T07:00:00.000Z',
      archived_at: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const createTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { createTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-create-1',
        method: 'kanban.ticket.create',
        params: payload
      })
    )

    expect(createTicket).toHaveBeenCalledWith('project-1', payload)
    expect(response).toEqual({
      id: 'kanban-ticket-create-1',
      ok: true,
      value: ticket
    })
  })

  it('validates kanban.ticket.create params before calling the provider service', async () => {
    const createTicket = vi.fn(() => Effect.succeed({}))
    const service = { createTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-create-invalid',
        method: 'kanban.ticket.create',
        params: {
          project_id: 'project-1',
          title: 'Ship HTTP migration',
          column: 'blocked'
        }
      })
    )

    expect(createTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-create-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.createBatch to the injected provider service', async () => {
    const payload = {
      drafts: [
        {
          draft_key: 'draft-plan',
          project_id: 'project-1',
          title: 'Plan migration',
          description: null,
          attachments: [],
          column: 'todo' as const,
          sort_order: 0,
          mode: 'plan' as const,
          plan_ready: true,
          depends_on: []
        },
        {
          draft_key: 'draft-ship',
          project_id: 'project-1',
          title: 'Ship migration',
          description: 'Move the call to RPC',
          attachments: [{ name: 'plan.md' }],
          column: 'in_progress' as const,
          sort_order: 1,
          mode: 'build' as const,
          plan_ready: false,
          depends_on: ['draft-plan']
        }
      ]
    }
    const firstTicket = {
      id: 'ticket-plan',
      project_id: 'project-1',
      title: 'Plan migration',
      description: null,
      attachments: [],
      column: 'todo' as const,
      sort_order: 0,
      current_session_id: null,
      worktree_id: null,
      mode: 'plan' as const,
      plan_ready: true,
      created_at: '2026-05-31T07:10:00.000Z',
      updated_at: '2026-05-31T07:10:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const secondTicket = {
      ...firstTicket,
      id: 'ticket-ship',
      title: 'Ship migration',
      description: 'Move the call to RPC',
      attachments: [{ name: 'plan.md' }],
      column: 'in_progress' as const,
      sort_order: 1,
      mode: 'build' as const,
      plan_ready: false
    }
    const result = {
      tickets: [firstTicket, secondTicket],
      dependencies: [
        {
          dependent_id: 'ticket-ship',
          blocker_id: 'ticket-plan',
          created_at: '2026-05-31T07:11:00.000Z'
        }
      ]
    }
    const createTicketBatch = vi.fn(() => Effect.succeed(result))
    const service = { createTicketBatch } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-create-batch-1',
        method: 'kanban.ticket.createBatch',
        params: { projectId: 'project-1', data: payload }
      })
    )

    expect(createTicketBatch).toHaveBeenCalledWith('project-1', payload)
    expect(response).toEqual({
      id: 'kanban-ticket-create-batch-1',
      ok: true,
      value: result
    })
  })

  it('validates kanban.ticket.createBatch params before calling the provider service', async () => {
    const createTicketBatch = vi.fn(() => Effect.succeed({ tickets: [], dependencies: [] }))
    const service = { createTicketBatch } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-create-batch-invalid',
        method: 'kanban.ticket.createBatch',
        params: {
          drafts: [
            {
              draft_key: 'draft-1',
              project_id: 'project-1',
              depends_on: ['missing-title']
            }
          ]
        }
      })
    )

    expect(createTicketBatch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-create-batch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.get to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Inspect migration',
      description: null,
      attachments: [{ name: 'trace.json' }],
      column: 'review' as const,
      sort_order: 3,
      current_session_id: 'session-1',
      worktree_id: 'worktree-1',
      mode: 'build' as const,
      plan_ready: false,
      created_at: '2026-05-31T07:20:00.000Z',
      updated_at: '2026-05-31T07:21:00.000Z',
      archived_at: null,
      external_provider: 'github',
      external_id: '42',
      external_url: 'https://github.com/acme/hive/issues/42',
      github_pr_number: 17,
      github_pr_url: 'https://github.com/acme/hive/pull/17',
      mark: 'rare' as const,
      total_tokens: 128,
      pending_launch_config: null,
      goal_mode: true,
      goal_success_criteria: 'All IPC calls moved to RPC',
      note: 'Keep this out of prompts'
    }
    const getTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { getTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-1',
        method: 'kanban.ticket.get',
        params: { projectId: 'project-1', id: 'ticket-1' }
      })
    )

    expect(getTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-ticket-get-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.get results from the injected provider service', async () => {
    const getTicket = vi.fn(() => Effect.succeed(null))
    const service = { getTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-missing',
        method: 'kanban.ticket.get',
        params: { projectId: 'project-1', id: 'missing-ticket' }
      })
    )

    expect(getTicket).toHaveBeenCalledWith('project-1', 'missing-ticket')
    expect(response).toEqual({
      id: 'kanban-ticket-get-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.get params before calling the provider service', async () => {
    const getTicket = vi.fn(() => Effect.succeed(null))
    const service = { getTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-invalid',
        method: 'kanban.ticket.get',
        params: { id: 123 }
      })
    )

    expect(getTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-get-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.getByProject to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Project ticket',
      description: null,
      attachments: [{ name: 'project.md' }],
      column: 'todo' as const,
      sort_order: 0,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: '2026-05-31T07:30:00.000Z',
      updated_at: '2026-05-31T07:31:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const getTicketsByProject = vi.fn(() => Effect.succeed([ticket]))
    const service = { getTicketsByProject } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-project-1',
        method: 'kanban.ticket.getByProject',
        params: { projectId: 'project-1', includeArchived: true }
      })
    )

    expect(getTicketsByProject).toHaveBeenCalledWith('project-1', true)
    expect(response).toEqual({
      id: 'kanban-ticket-get-by-project-1',
      ok: true,
      value: [ticket]
    })
  })

  it('preserves omitted includeArchived and empty kanban.ticket.getByProject results', async () => {
    const getTicketsByProject = vi.fn(() => Effect.succeed([]))
    const service = { getTicketsByProject } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-project-empty',
        method: 'kanban.ticket.getByProject',
        params: { projectId: 'project-1' }
      })
    )

    expect(getTicketsByProject).toHaveBeenCalledWith('project-1', undefined)
    expect(response).toEqual({
      id: 'kanban-ticket-get-by-project-empty',
      ok: true,
      value: []
    })
  })

  it('validates kanban.ticket.getByProject params before calling the provider service', async () => {
    const getTicketsByProject = vi.fn(() => Effect.succeed([]))
    const service = { getTicketsByProject } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-project-invalid',
        method: 'kanban.ticket.getByProject',
        params: { projectId: 'project-1', includeArchived: 'yes' }
      })
    )

    expect(getTicketsByProject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-get-by-project-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.update to the injected provider service', async () => {
    const data = {
      title: 'Updated migration',
      description: 'Updated description',
      attachments: [{ name: 'updated.md' }],
      column: 'in_progress' as const,
      sort_order: 4,
      current_session_id: 'session-1',
      worktree_id: 'worktree-1',
      mode: 'plan' as const,
      plan_ready: true,
      github_pr_number: 42,
      github_pr_url: 'https://github.com/acme/hive/pull/42',
      mark: 'legendary' as const,
      pending_launch_config: 'npm test',
      goal_mode: true,
      goal_success_criteria: 'Build passes',
      note: 'Private note'
    }
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      ...data,
      created_at: '2026-05-31T07:40:00.000Z',
      updated_at: '2026-05-31T07:41:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      total_tokens: 64
    }
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { updateTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-update-1',
        method: 'kanban.ticket.update',
        params: { projectId: 'project-1', id: 'ticket-1', data }
      })
    )

    expect(updateTicket).toHaveBeenCalledWith('project-1', 'ticket-1', data)
    expect(response).toEqual({
      id: 'kanban-ticket-update-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.update results from the injected provider service', async () => {
    const data = { title: 'Missing ticket update' }
    const updateTicket = vi.fn(() => Effect.succeed(null))
    const service = { updateTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-update-missing',
        method: 'kanban.ticket.update',
        params: { projectId: 'project-1', id: 'missing-ticket', data }
      })
    )

    expect(updateTicket).toHaveBeenCalledWith('project-1', 'missing-ticket', data)
    expect(response).toEqual({
      id: 'kanban-ticket-update-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.update params before calling the provider service', async () => {
    const updateTicket = vi.fn(() => Effect.succeed(null))
    const service = { updateTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-update-invalid',
        method: 'kanban.ticket.update',
        params: { id: 'ticket-1', data: { column: 'doing' } }
      })
    )

    expect(updateTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-update-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.delete to the injected provider service', async () => {
    const deleteTicket = vi.fn(() => Effect.succeed(true))
    const service = { deleteTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-delete-1',
        method: 'kanban.ticket.delete',
        params: { projectId: 'project-1', id: 'ticket-1' }
      })
    )

    expect(deleteTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-ticket-delete-1',
      ok: true,
      value: true
    })
  })

  it('preserves false kanban.ticket.delete results from the injected provider service', async () => {
    const deleteTicket = vi.fn(() => Effect.succeed(false))
    const service = { deleteTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-delete-missing',
        method: 'kanban.ticket.delete',
        params: { projectId: 'project-1', id: 'missing-ticket' }
      })
    )

    expect(deleteTicket).toHaveBeenCalledWith('project-1', 'missing-ticket')
    expect(response).toEqual({
      id: 'kanban-ticket-delete-missing',
      ok: true,
      value: false
    })
  })

  it('validates kanban.ticket.delete params before calling the provider service', async () => {
    const deleteTicket = vi.fn(() => Effect.succeed(false))
    const service = { deleteTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-delete-invalid',
        method: 'kanban.ticket.delete',
        params: { id: 123 }
      })
    )

    expect(deleteTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-delete-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.archive to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Archived migration',
      description: null,
      attachments: [{ name: 'archive.md' }],
      column: 'done' as const,
      sort_order: 8,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: '2026-05-31T07:50:00.000Z',
      updated_at: '2026-05-31T07:51:00.000Z',
      archived_at: '2026-05-31T07:51:00.000Z',
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const archiveTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { archiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-1',
        method: 'kanban.ticket.archive',
        params: { projectId: 'project-1', id: 'ticket-1' }
      })
    )

    expect(archiveTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-ticket-archive-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.archive results from the injected provider service', async () => {
    const archiveTicket = vi.fn(() => Effect.succeed(null))
    const service = { archiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-missing',
        method: 'kanban.ticket.archive',
        params: { projectId: 'project-1', id: 'missing-ticket' }
      })
    )

    expect(archiveTicket).toHaveBeenCalledWith('project-1', 'missing-ticket')
    expect(response).toEqual({
      id: 'kanban-ticket-archive-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.archive params before calling the provider service', async () => {
    const archiveTicket = vi.fn(() => Effect.succeed(null))
    const service = { archiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-invalid',
        method: 'kanban.ticket.archive',
        params: { id: 123 }
      })
    )

    expect(archiveTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-archive-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.archiveAllDone to the injected provider service', async () => {
    const archiveAllDoneTickets = vi.fn(() => Effect.succeed(3))
    const service = { archiveAllDoneTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-all-done-1',
        method: 'kanban.ticket.archiveAllDone',
        params: { projectId: 'project-1' }
      })
    )

    expect(archiveAllDoneTickets).toHaveBeenCalledWith('project-1')
    expect(response).toEqual({
      id: 'kanban-ticket-archive-all-done-1',
      ok: true,
      value: 3
    })
  })

  it('preserves zero kanban.ticket.archiveAllDone results from the injected provider service', async () => {
    const archiveAllDoneTickets = vi.fn(() => Effect.succeed(0))
    const service = { archiveAllDoneTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-all-done-zero',
        method: 'kanban.ticket.archiveAllDone',
        params: { projectId: 'project-1' }
      })
    )

    expect(archiveAllDoneTickets).toHaveBeenCalledWith('project-1')
    expect(response).toEqual({
      id: 'kanban-ticket-archive-all-done-zero',
      ok: true,
      value: 0
    })
  })

  it('validates kanban.ticket.archiveAllDone params before calling the provider service', async () => {
    const archiveAllDoneTickets = vi.fn(() => Effect.succeed(0))
    const service = { archiveAllDoneTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-archive-all-done-invalid',
        method: 'kanban.ticket.archiveAllDone',
        params: { projectId: 123 }
      })
    )

    expect(archiveAllDoneTickets).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-archive-all-done-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.unarchive to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Restored migration',
      description: null,
      attachments: [{ name: 'restore.md' }],
      column: 'done' as const,
      sort_order: 8,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: '2026-05-31T08:00:00.000Z',
      updated_at: '2026-05-31T08:01:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const unarchiveTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { unarchiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-unarchive-1',
        method: 'kanban.ticket.unarchive',
        params: { projectId: 'project-1', id: 'ticket-1' }
      })
    )

    expect(unarchiveTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-ticket-unarchive-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.unarchive results from the injected provider service', async () => {
    const unarchiveTicket = vi.fn(() => Effect.succeed(null))
    const service = { unarchiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-unarchive-missing',
        method: 'kanban.ticket.unarchive',
        params: { projectId: 'project-1', id: 'missing-ticket' }
      })
    )

    expect(unarchiveTicket).toHaveBeenCalledWith('project-1', 'missing-ticket')
    expect(response).toEqual({
      id: 'kanban-ticket-unarchive-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.unarchive params before calling the provider service', async () => {
    const unarchiveTicket = vi.fn(() => Effect.succeed(null))
    const service = { unarchiveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-unarchive-invalid',
        method: 'kanban.ticket.unarchive',
        params: { id: 123 }
      })
    )

    expect(unarchiveTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-unarchive-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.move to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Moved migration',
      description: null,
      attachments: [{ name: 'move.md' }],
      column: 'review' as const,
      sort_order: 12,
      current_session_id: null,
      worktree_id: 'worktree-1',
      mode: 'build' as const,
      plan_ready: false,
      created_at: '2026-05-31T08:10:00.000Z',
      updated_at: '2026-05-31T08:11:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 32,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const moveTicket = vi.fn(() => Effect.succeed(ticket))
    const service = { moveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-move-1',
        method: 'kanban.ticket.move',
        params: { projectId: 'project-1', id: 'ticket-1', column: 'review', sortOrder: 12 }
      })
    )

    expect(moveTicket).toHaveBeenCalledWith('project-1', 'ticket-1', 'review', 12)
    expect(response).toEqual({
      id: 'kanban-ticket-move-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.move results from the injected provider service', async () => {
    const moveTicket = vi.fn(() => Effect.succeed(null))
    const service = { moveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-move-missing',
        method: 'kanban.ticket.move',
        params: { projectId: 'project-1', id: 'missing-ticket', column: 'done', sortOrder: 99 }
      })
    )

    expect(moveTicket).toHaveBeenCalledWith('project-1', 'missing-ticket', 'done', 99)
    expect(response).toEqual({
      id: 'kanban-ticket-move-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.move params before calling the provider service', async () => {
    const moveTicket = vi.fn(() => Effect.succeed(null))
    const service = { moveTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-move-invalid',
        method: 'kanban.ticket.move',
        params: { id: 'ticket-1', column: 'blocked', sortOrder: 12 }
      })
    )

    expect(moveTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-move-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.reorder to the injected provider service', async () => {
    const reorderTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { reorderTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-reorder-1',
        method: 'kanban.ticket.reorder',
        params: { projectId: 'project-1', id: 'ticket-1', sortOrder: 42 }
      })
    )

    expect(reorderTicket).toHaveBeenCalledWith('project-1', 'ticket-1', 42)
    expect(response).toEqual({
      id: 'kanban-ticket-reorder-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.ticket.reorder params before calling the provider service', async () => {
    const reorderTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { reorderTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-reorder-invalid',
        method: 'kanban.ticket.reorder',
        params: { id: 'ticket-1', sortOrder: 'last' }
      })
    )

    expect(reorderTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-reorder-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.getBySession to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Session ticket',
      description: null,
      attachments: [{ name: 'session.md' }],
      column: 'in_progress' as const,
      sort_order: 5,
      current_session_id: 'session-1',
      worktree_id: 'worktree-1',
      mode: 'build' as const,
      plan_ready: false,
      created_at: '2026-05-31T08:20:00.000Z',
      updated_at: '2026-05-31T08:21:00.000Z',
      archived_at: null,
      external_provider: 'github',
      external_id: '123',
      external_url: 'https://github.com/acme/hive/issues/123',
      github_pr_number: null,
      github_pr_url: null,
      mark: 'common' as const,
      total_tokens: 256,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const getTicketsBySession = vi.fn(() => Effect.succeed([ticket]))
    const service = { getTicketsBySession } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-session-1',
        method: 'kanban.ticket.getBySession',
        params: { sessionId: 'session-1' }
      })
    )

    expect(getTicketsBySession).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'kanban-ticket-get-by-session-1',
      ok: true,
      value: [ticket]
    })
  })

  it('preserves empty kanban.ticket.getBySession results from the injected provider service', async () => {
    const getTicketsBySession = vi.fn(() => Effect.succeed([]))
    const service = { getTicketsBySession } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-session-empty',
        method: 'kanban.ticket.getBySession',
        params: { sessionId: 'session-1' }
      })
    )

    expect(getTicketsBySession).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'kanban-ticket-get-by-session-empty',
      ok: true,
      value: []
    })
  })

  it('validates kanban.ticket.getBySession params before calling the provider service', async () => {
    const getTicketsBySession = vi.fn(() => Effect.succeed([]))
    const service = { getTicketsBySession } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-get-by-session-invalid',
        method: 'kanban.ticket.getBySession',
        params: { sessionId: 123 }
      })
    )

    expect(getTicketsBySession).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-get-by-session-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.addTokens to the injected provider service', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Token migration',
      description: null,
      attachments: [{ name: 'tokens.md' }],
      column: 'in_progress' as const,
      sort_order: 6,
      current_session_id: 'session-1',
      worktree_id: 'worktree-1',
      mode: 'build' as const,
      plan_ready: false,
      created_at: '2026-05-31T08:30:00.000Z',
      updated_at: '2026-05-31T08:31:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 384,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const addTicketTokens = vi.fn(() => Effect.succeed(ticket))
    const service = { addTicketTokens } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-add-tokens-1',
        method: 'kanban.ticket.addTokens',
        params: { projectId: 'project-1', id: 'ticket-1', tokens: 128 }
      })
    )

    expect(addTicketTokens).toHaveBeenCalledWith('project-1', 'ticket-1', 128)
    expect(response).toEqual({
      id: 'kanban-ticket-add-tokens-1',
      ok: true,
      value: ticket
    })
  })

  it('preserves null kanban.ticket.addTokens results from the injected provider service', async () => {
    const addTicketTokens = vi.fn(() => Effect.succeed(null))
    const service = { addTicketTokens } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-add-tokens-missing',
        method: 'kanban.ticket.addTokens',
        params: { projectId: 'project-1', id: 'missing-ticket', tokens: 128 }
      })
    )

    expect(addTicketTokens).toHaveBeenCalledWith('project-1', 'missing-ticket', 128)
    expect(response).toEqual({
      id: 'kanban-ticket-add-tokens-missing',
      ok: true,
      value: null
    })
  })

  it('validates kanban.ticket.addTokens params before calling the provider service', async () => {
    const addTicketTokens = vi.fn(() => Effect.succeed(null))
    const service = { addTicketTokens } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-add-tokens-invalid',
        method: 'kanban.ticket.addTokens',
        params: { id: 'ticket-1', tokens: '128' }
      })
    )

    expect(addTicketTokens).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-add-tokens-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.syncPR to the injected provider service', async () => {
    const syncPrToTickets = vi.fn(() => Effect.succeed(undefined))
    const service = { syncPrToTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-sync-pr-1',
        method: 'kanban.ticket.syncPR',
        params: {
          worktreeId: 'worktree-1',
          prNumber: 42,
          prUrl: 'https://github.com/acme/hive/pull/42'
        }
      })
    )

    expect(syncPrToTickets).toHaveBeenCalledWith(
      'worktree-1',
      42,
      'https://github.com/acme/hive/pull/42'
    )
    expect(response).toEqual({
      id: 'kanban-ticket-sync-pr-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.ticket.syncPR params before calling the provider service', async () => {
    const syncPrToTickets = vi.fn(() => Effect.succeed(undefined))
    const service = { syncPrToTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-sync-pr-invalid',
        method: 'kanban.ticket.syncPR',
        params: {
          worktreeId: 'worktree-1',
          prNumber: '42',
          prUrl: 'https://github.com/acme/hive/pull/42'
        }
      })
    )

    expect(syncPrToTickets).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-sync-pr-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.clearPR to the injected provider service', async () => {
    const clearPrFromTickets = vi.fn(() => Effect.succeed(undefined))
    const service = { clearPrFromTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-clear-pr-1',
        method: 'kanban.ticket.clearPR',
        params: { worktreeId: 'worktree-1' }
      })
    )

    expect(clearPrFromTickets).toHaveBeenCalledWith('worktree-1')
    expect(response).toEqual({
      id: 'kanban-ticket-clear-pr-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.ticket.clearPR params before calling the provider service', async () => {
    const clearPrFromTickets = vi.fn(() => Effect.succeed(undefined))
    const service = { clearPrFromTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-clear-pr-invalid',
        method: 'kanban.ticket.clearPR',
        params: { worktreeId: 123 }
      })
    )

    expect(clearPrFromTickets).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-clear-pr-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.attachPR to the injected provider service', async () => {
    const attachPrToTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { attachPrToTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-attach-pr-1',
        method: 'kanban.ticket.attachPR',
        params: {
          ticketId: 'ticket-1',
          projectId: 'project-1',
          prNumber: 42,
          prUrl: 'https://github.com/acme/hive/pull/42'
        }
      })
    )

    expect(attachPrToTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      42,
      'https://github.com/acme/hive/pull/42'
    )
    expect(response).toEqual({
      id: 'kanban-ticket-attach-pr-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.ticket.attachPR params before calling the provider service', async () => {
    const attachPrToTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { attachPrToTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-attach-pr-invalid',
        method: 'kanban.ticket.attachPR',
        params: {
          ticketId: 'ticket-1',
          projectId: 'project-1',
          prNumber: 42,
          prUrl: null
        }
      })
    )

    expect(attachPrToTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-attach-pr-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.detachPR to the injected provider service', async () => {
    const detachPrFromTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { detachPrFromTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-detach-pr-1',
        method: 'kanban.ticket.detachPR',
        params: {
          ticketId: 'ticket-1',
          projectId: 'project-1'
        }
      })
    )

    expect(detachPrFromTicket).toHaveBeenCalledWith('ticket-1', 'project-1')
    expect(response).toEqual({
      id: 'kanban-ticket-detach-pr-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.ticket.detachPR params before calling the provider service', async () => {
    const detachPrFromTicket = vi.fn(() => Effect.succeed(undefined))
    const service = { detachPrFromTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-detach-pr-invalid',
        method: 'kanban.ticket.detachPR',
        params: {
          ticketId: 'ticket-1',
          projectId: 123
        }
      })
    )

    expect(detachPrFromTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-detach-pr-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.ticket.detachWorktree to the injected provider service', async () => {
    const detachWorktreeFromTickets = vi.fn(() => Effect.succeed(3))
    const service = { detachWorktreeFromTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-detach-worktree-1',
        method: 'kanban.ticket.detachWorktree',
        params: {
          worktreeId: 'worktree-1'
        }
      })
    )

    expect(detachWorktreeFromTickets).toHaveBeenCalledWith('worktree-1')
    expect(response).toEqual({
      id: 'kanban-ticket-detach-worktree-1',
      ok: true,
      value: 3
    })
  })

  it('validates kanban.ticket.detachWorktree params before calling the provider service', async () => {
    const detachWorktreeFromTickets = vi.fn(() => Effect.succeed(0))
    const service = { detachWorktreeFromTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-ticket-detach-worktree-invalid',
        method: 'kanban.ticket.detachWorktree',
        params: {
          worktreeId: 123
        }
      })
    )

    expect(detachWorktreeFromTickets).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-ticket-detach-worktree-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.simpleMode.toggle to the injected provider service', async () => {
    const updateProjectSimpleMode = vi.fn(() => Effect.succeed(undefined))
    const service = { updateProjectSimpleMode } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-simple-mode-toggle-1',
        method: 'kanban.simpleMode.toggle',
        params: {
          projectId: 'project-1',
          enabled: true
        }
      })
    )

    expect(updateProjectSimpleMode).toHaveBeenCalledWith('project-1', true)
    expect(response).toEqual({
      id: 'kanban-simple-mode-toggle-1',
      ok: true,
      value: undefined
    })
  })

  it('validates kanban.simpleMode.toggle params before calling the provider service', async () => {
    const updateProjectSimpleMode = vi.fn(() => Effect.succeed(undefined))
    const service = { updateProjectSimpleMode } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-simple-mode-toggle-invalid',
        method: 'kanban.simpleMode.toggle',
        params: {
          projectId: 'project-1',
          enabled: 'true'
        }
      })
    )

    expect(updateProjectSimpleMode).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-simple-mode-toggle-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.add to the injected provider service', async () => {
    const result = { success: false, error: 'Dependency would create a cycle' }
    const addTicketDependency = vi.fn(() => Effect.succeed(result))
    const service = { addTicketDependency } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-add-1',
        method: 'kanban.dependency.add',
        params: {
          projectId: 'project-1',
          dependentId: 'ticket-1',
          blockerId: 'ticket-2'
        }
      })
    )

    expect(addTicketDependency).toHaveBeenCalledWith('project-1', 'ticket-1', 'ticket-2')
    expect(response).toEqual({
      id: 'kanban-dependency-add-1',
      ok: true,
      value: result
    })
  })

  it('validates kanban.dependency.add params before calling the provider service', async () => {
    const addTicketDependency = vi.fn(() => Effect.succeed({ success: true }))
    const service = { addTicketDependency } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-add-invalid',
        method: 'kanban.dependency.add',
        params: {
          dependentId: 'ticket-1',
          blockerId: 123
        }
      })
    )

    expect(addTicketDependency).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-add-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.remove to the injected provider service', async () => {
    const removeTicketDependency = vi.fn(() => Effect.succeed(false))
    const service = { removeTicketDependency } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-remove-1',
        method: 'kanban.dependency.remove',
        params: {
          projectId: 'project-1',
          dependentId: 'ticket-1',
          blockerId: 'ticket-2'
        }
      })
    )

    expect(removeTicketDependency).toHaveBeenCalledWith('project-1', 'ticket-1', 'ticket-2')
    expect(response).toEqual({
      id: 'kanban-dependency-remove-1',
      ok: true,
      value: false
    })
  })

  it('validates kanban.dependency.remove params before calling the provider service', async () => {
    const removeTicketDependency = vi.fn(() => Effect.succeed(true))
    const service = { removeTicketDependency } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-remove-invalid',
        method: 'kanban.dependency.remove',
        params: {
          dependentId: 123,
          blockerId: 'ticket-2'
        }
      })
    )

    expect(removeTicketDependency).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-remove-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.getBlockers to the injected provider service', async () => {
    const blockerTicket = {
      id: 'ticket-2',
      project_id: 'project-1',
      title: 'Blocking ticket',
      description: null,
      attachments: [],
      column: 'todo' as const,
      sort_order: 0,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: '2026-05-31T08:00:00.000Z',
      updated_at: '2026-05-31T08:00:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const getBlockersForTicket = vi.fn(() => Effect.succeed([blockerTicket]))
    const service = { getBlockersForTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-blockers-1',
        method: 'kanban.dependency.getBlockers',
        params: {
          projectId: 'project-1',
          id: 'ticket-1'
        }
      })
    )

    expect(getBlockersForTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-dependency-get-blockers-1',
      ok: true,
      value: [blockerTicket]
    })
  })

  it('validates kanban.dependency.getBlockers params before calling the provider service', async () => {
    const getBlockersForTicket = vi.fn(() => Effect.succeed([]))
    const service = { getBlockersForTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-blockers-invalid',
        method: 'kanban.dependency.getBlockers',
        params: {
          id: 123
        }
      })
    )

    expect(getBlockersForTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-get-blockers-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.getDependents to the injected provider service', async () => {
    const dependentTicket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Dependent ticket',
      description: null,
      attachments: [],
      column: 'review' as const,
      sort_order: 1,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: '2026-05-31T08:05:00.000Z',
      updated_at: '2026-05-31T08:05:00.000Z',
      archived_at: null,
      external_provider: null,
      external_id: null,
      external_url: null,
      github_pr_number: null,
      github_pr_url: null,
      mark: null,
      total_tokens: 0,
      pending_launch_config: null,
      goal_mode: false,
      goal_success_criteria: null,
      note: null
    }
    const getDependentsOfTicket = vi.fn(() => Effect.succeed([dependentTicket]))
    const service = { getDependentsOfTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-dependents-1',
        method: 'kanban.dependency.getDependents',
        params: {
          projectId: 'project-1',
          id: 'ticket-2'
        }
      })
    )

    expect(getDependentsOfTicket).toHaveBeenCalledWith('project-1', 'ticket-2')
    expect(response).toEqual({
      id: 'kanban-dependency-get-dependents-1',
      ok: true,
      value: [dependentTicket]
    })
  })

  it('validates kanban.dependency.getDependents params before calling the provider service', async () => {
    const getDependentsOfTicket = vi.fn(() => Effect.succeed([]))
    const service = { getDependentsOfTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-dependents-invalid',
        method: 'kanban.dependency.getDependents',
        params: {
          id: 123
        }
      })
    )

    expect(getDependentsOfTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-get-dependents-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.getForProject to the injected provider service', async () => {
    const dependency = {
      dependent_id: 'ticket-1',
      blocker_id: 'ticket-2',
      created_at: '2026-05-31T08:10:00.000Z'
    }
    const getDependenciesForProject = vi.fn(() => Effect.succeed([dependency]))
    const service = { getDependenciesForProject } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-for-project-1',
        method: 'kanban.dependency.getForProject',
        params: {
          projectId: 'project-1'
        }
      })
    )

    expect(getDependenciesForProject).toHaveBeenCalledWith('project-1')
    expect(response).toEqual({
      id: 'kanban-dependency-get-for-project-1',
      ok: true,
      value: [dependency]
    })
  })

  it('validates kanban.dependency.getForProject params before calling the provider service', async () => {
    const getDependenciesForProject = vi.fn(() => Effect.succeed([]))
    const service = { getDependenciesForProject } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-get-for-project-invalid',
        method: 'kanban.dependency.getForProject',
        params: {
          projectId: 123
        }
      })
    )

    expect(getDependenciesForProject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-get-for-project-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.dependency.removeAll to the injected provider service', async () => {
    const removeAllDependenciesForTicket = vi.fn(() => Effect.succeed(4))
    const service = { removeAllDependenciesForTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-remove-all-1',
        method: 'kanban.dependency.removeAll',
        params: {
          projectId: 'project-1',
          id: 'ticket-1'
        }
      })
    )

    expect(removeAllDependenciesForTicket).toHaveBeenCalledWith('project-1', 'ticket-1')
    expect(response).toEqual({
      id: 'kanban-dependency-remove-all-1',
      ok: true,
      value: 4
    })
  })

  it('validates kanban.dependency.removeAll params before calling the provider service', async () => {
    const removeAllDependenciesForTicket = vi.fn(() => Effect.succeed(0))
    const service = { removeAllDependenciesForTicket } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-dependency-remove-all-invalid',
        method: 'kanban.dependency.removeAll',
        params: {
          id: 123
        }
      })
    )

    expect(removeAllDependenciesForTicket).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-dependency-remove-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.board.export to the injected provider service', async () => {
    const result = {
      success: false,
      ticketCount: 0,
      error: 'Save cancelled'
    }
    const exportBoard = vi.fn(() => Effect.succeed(result))
    const service = { exportBoard } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-export-1',
        method: 'kanban.board.export',
        params: {
          projectId: 'project-1',
          projectName: 'Hive'
        }
      })
    )

    expect(exportBoard).toHaveBeenCalledWith('project-1', 'Hive')
    expect(response).toEqual({
      id: 'kanban-board-export-1',
      ok: true,
      value: result
    })
  })

  it('validates kanban.board.export params before calling the provider service', async () => {
    const exportBoard = vi.fn(() =>
      Effect.succeed({
        success: true,
        ticketCount: 1,
        path: '/tmp/hive-board.json'
      })
    )
    const service = { exportBoard } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-export-invalid',
        method: 'kanban.board.export',
        params: {
          projectId: 'project-1',
          projectName: 123
        }
      })
    )

    expect(exportBoard).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-board-export-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.board.openImportFile to the injected provider service', async () => {
    const result = {
      tickets: [
        {
          id: 'ticket-1',
          title: 'Imported ticket',
          description: null,
          attachments: [],
          column: 'todo'
        }
      ],
      dependencies: [{ dependentId: 'ticket-1', blockerId: 'ticket-2' }],
      projectName: 'Imported board'
    }
    const openBoardImportFile = vi.fn(() => Effect.succeed(result))
    const service = { openBoardImportFile } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-open-import-file-1',
        method: 'kanban.board.openImportFile',
        params: {}
      })
    )

    expect(openBoardImportFile).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'kanban-board-open-import-file-1',
      ok: true,
      value: result
    })
  })

  it('preserves null kanban.board.openImportFile results from the provider service', async () => {
    const openBoardImportFile = vi.fn(() => Effect.succeed(null))
    const service = { openBoardImportFile } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-open-import-file-null',
        method: 'kanban.board.openImportFile',
        params: {}
      })
    )

    expect(openBoardImportFile).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'kanban-board-open-import-file-null',
      ok: true,
      value: null
    })
  })

  it('validates kanban.board.openImportFile params before calling the provider service', async () => {
    const openBoardImportFile = vi.fn(() => Effect.succeed(null))
    const service = { openBoardImportFile } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-open-import-file-invalid',
        method: 'kanban.board.openImportFile',
        params: {
          path: '/tmp/board.json'
        }
      })
    )

    expect(openBoardImportFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-board-open-import-file-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes kanban.board.importTickets to the injected provider service', async () => {
    const tickets = [
      {
        id: 'ticket-1',
        title: 'Imported ticket',
        description: null,
        attachments: [{ name: 'note.txt' }],
        column: 'todo'
      }
    ]
    const dependencies = [{ dependentId: 'ticket-1', blockerId: 'ticket-2' }]
    const result = {
      created: 1,
      updated: 0,
      dependencyCount: 0,
      ignoredDependencyCount: 1
    }
    const importBoardTickets = vi.fn(() => Effect.succeed(result))
    const service = { importBoardTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-import-tickets-1',
        method: 'kanban.board.importTickets',
        params: {
          projectId: 'project-1',
          tickets,
          dependencies
        }
      })
    )

    expect(importBoardTickets).toHaveBeenCalledWith('project-1', tickets, dependencies)
    expect(response).toEqual({
      id: 'kanban-board-import-tickets-1',
      ok: true,
      value: result
    })
  })

  it('routes kanban.board.importTickets without optional dependencies', async () => {
    const tickets = [
      {
        id: 'ticket-1',
        title: 'Imported ticket'
      }
    ]
    const result = {
      created: 0,
      updated: 1,
      dependencyCount: 0,
      ignoredDependencyCount: 0
    }
    const importBoardTickets = vi.fn(() => Effect.succeed(result))
    const service = { importBoardTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-import-tickets-no-dependencies',
        method: 'kanban.board.importTickets',
        params: {
          projectId: 'project-1',
          tickets
        }
      })
    )

    expect(importBoardTickets).toHaveBeenCalledWith('project-1', tickets, undefined)
    expect(response).toEqual({
      id: 'kanban-board-import-tickets-no-dependencies',
      ok: true,
      value: result
    })
  })

  it('validates kanban.board.importTickets params before calling the provider service', async () => {
    const importBoardTickets = vi.fn(() =>
      Effect.succeed({
        created: 0,
        updated: 0,
        dependencyCount: 0,
        ignoredDependencyCount: 0
      })
    )
    const service = { importBoardTickets } as unknown as KanbanRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      kanban: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'kanban-board-import-tickets-invalid',
        method: 'kanban.board.importTickets',
        params: {
          projectId: 'project-1',
          tickets: [{ id: 'ticket-1', title: 123 }]
        }
      })
    )

    expect(importBoardTickets).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'kanban-board-import-tickets-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
