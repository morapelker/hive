import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLiveTicketImportRpcService } from '../rpc/domains/ticket-import'

const kanbanBackendMocks = vi.hoisted(() => ({
  backend: {
    list: vi.fn(),
    create: vi.fn()
  },
  getKanbanBackendForProject: vi.fn()
}))

vi.mock('../../main/services/kanban-backend', () => ({
  getKanbanBackendForProject: kanbanBackendMocks.getKanbanBackendForProject
}))

describe('live ticket import service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kanbanBackendMocks.getKanbanBackendForProject.mockReturnValue(kanbanBackendMocks.backend)
    kanbanBackendMocks.backend.list.mockResolvedValue([])
    kanbanBackendMocks.backend.create.mockImplementation(async (_projectId, data) => ({
      id: `ticket-${data.external_id}`,
      ...data
    }))
  })

  it('imports issues through the routed Kanban backend and skips existing external ids', async () => {
    kanbanBackendMocks.backend.list.mockResolvedValue([
      {
        id: 'archived-ticket',
        project_id: 'project-1',
        title: 'Already imported',
        description: null,
        attachments: [],
        column: 'done',
        sort_order: 0,
        archived_at: '2026-01-01T00:00:00.000Z',
        current_session_id: null,
        worktree_id: null,
        mode: null,
        plan_ready: false,
        external_provider: 'github',
        external_id: '42',
        external_url: 'https://github.test/acme/hive/issues/42',
        github_pr_number: null,
        github_pr_url: null,
        mark: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ])

    const service = makeLiveTicketImportRpcService()
    const result = await Effect.runPromise(
      service.importIssues('github', 'project-1', 'acme/hive', [
        {
          externalId: '42',
          title: 'Existing issue',
          body: 'Existing body',
          state: 'open',
          url: 'https://github.test/acme/hive/issues/42'
        },
        {
          externalId: '43',
          title: 'Closed issue',
          body: 'Closed body',
          state: 'closed',
          url: 'https://github.test/acme/hive/issues/43'
        },
        {
          externalId: '44',
          title: 'Active issue',
          body: null,
          state: 'in_progress',
          url: 'https://github.test/acme/hive/issues/44'
        },
        {
          externalId: '45',
          title: 'Open issue',
          body: 'Open body',
          state: 'open',
          url: 'https://github.test/acme/hive/issues/45'
        },
        {
          externalId: '43',
          title: 'Duplicate in request',
          body: 'Duplicate body',
          state: 'open',
          url: 'https://github.test/acme/hive/issues/43'
        }
      ])
    )

    expect(kanbanBackendMocks.getKanbanBackendForProject).toHaveBeenCalledWith('project-1')
    expect(kanbanBackendMocks.backend.list).toHaveBeenCalledWith('project-1', true)
    expect(kanbanBackendMocks.backend.create).toHaveBeenCalledTimes(3)
    expect(kanbanBackendMocks.backend.create).toHaveBeenNthCalledWith(1, 'project-1', {
      project_id: 'project-1',
      title: 'Closed issue',
      description: 'Closed body',
      column: 'done',
      external_provider: 'github',
      external_id: '43',
      external_url: 'https://github.test/acme/hive/issues/43'
    })
    expect(kanbanBackendMocks.backend.create).toHaveBeenNthCalledWith(2, 'project-1', {
      project_id: 'project-1',
      title: 'Active issue',
      description: null,
      column: 'in_progress',
      external_provider: 'github',
      external_id: '44',
      external_url: 'https://github.test/acme/hive/issues/44'
    })
    expect(kanbanBackendMocks.backend.create).toHaveBeenNthCalledWith(3, 'project-1', {
      project_id: 'project-1',
      title: 'Open issue',
      description: 'Open body',
      column: 'todo',
      external_provider: 'github',
      external_id: '45',
      external_url: 'https://github.test/acme/hive/issues/45'
    })
    expect(result).toEqual({
      imported: ['43', '44', '45'],
      skipped: ['42', '43']
    })
  })

  it('does not use direct SQLite Kanban ticket writes in the live import path', () => {
    const source = readFileSync(join(__dirname, '../rpc/domains/ticket-import.ts'), 'utf-8')

    expect(source).not.toContain('getKanbanTicketByExternalId')
    expect(source).not.toContain('createKanbanTicket')
  })
})
