import { afterEach, describe, expect, it, vi } from 'vitest'
import { kanbanApi } from '../kanban-api'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'

describe('kanbanApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes board.openImportFile through the renderer RPC client', async () => {
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
      projectName: null
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.board.openImportFile<typeof result>()).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('kanban.board.openImportFile', {})
  })

  it('routes board.export through the renderer RPC client', async () => {
    const result = {
      success: true,
      ticketCount: 3,
      path: '/tmp/Hive.hive.json'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.board.export<typeof result>('project-1', 'Hive')).resolves.toEqual(
      result
    )
    expect(request).toHaveBeenCalledWith('kanban.board.export', {
      projectId: 'project-1',
      projectName: 'Hive'
    })
  })

  it('routes board.importTickets through the renderer RPC client', async () => {
    const result = {
      created: 1,
      updated: 2,
      dependencyCount: 1,
      ignoredDependencyCount: 0
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const tickets = [
      {
        id: 'ticket-1',
        title: 'Imported ticket',
        description: null,
        attachments: [],
        column: 'todo'
      }
    ]
    const dependencies = [{ dependentId: 'ticket-1', blockerId: 'ticket-2' }]

    await expect(
      kanbanApi.board.importTickets<
        typeof result,
        (typeof tickets)[number],
        (typeof dependencies)[number]
      >('project-1', tickets, dependencies)
    ).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('kanban.board.importTickets', {
      projectId: 'project-1',
      tickets,
      dependencies
    })
  })

  it('routes ticket.create through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Fix the board',
      column: 'todo'
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const data = {
      project_id: 'project-1',
      title: 'Fix the board',
      description: null
    }
    await expect(
      kanbanApi.ticket.create<typeof ticket, typeof data>('project-1', data)
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.create', data)
  })

  it('routes ticket.createBatch through the renderer RPC client', async () => {
    const result = {
      tickets: [{ id: 'ticket-1', project_id: 'project-1', title: 'Draft ticket' }],
      dependencies: []
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const data = {
      drafts: [
        {
          draft_key: 'draft-1',
          project_id: 'project-1',
          title: 'Draft ticket',
          description: null,
          column: 'todo',
          depends_on: []
        }
      ]
    }
    await expect(
      kanbanApi.ticket.createBatch<typeof result, typeof data>('project-1', data)
    ).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('kanban.ticket.createBatch', {
      projectId: 'project-1',
      data
    })
  })

  it('routes ticket.update through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Updated board fix',
      column: 'in_progress'
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const data = {
      title: 'Updated board fix',
      column: 'in_progress'
    }
    await expect(
      kanbanApi.ticket.update<typeof ticket, typeof data>('project-1', 'ticket-1', data)
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.update', {
      projectId: 'project-1',
      id: 'ticket-1',
      data
    })
  })

  it('routes ticket.delete through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.delete('project-1', 'ticket-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('kanban.ticket.delete', {
      projectId: 'project-1',
      id: 'ticket-1'
    })
  })

  it('routes ticket.archive through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Archived board fix',
      column: 'done',
      archived_at: '2026-05-29T00:00:00.000Z'
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.archive<typeof ticket>('project-1', 'ticket-1')
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.archive', {
      projectId: 'project-1',
      id: 'ticket-1'
    })
  })

  it('routes ticket.archiveAllDone through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(3)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.archiveAllDone('project-1')).resolves.toBe(3)
    expect(request).toHaveBeenCalledWith('kanban.ticket.archiveAllDone', {
      projectId: 'project-1'
    })
  })

  it('routes ticket.unarchive through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Unarchived board fix',
      column: 'done',
      archived_at: null
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.unarchive<typeof ticket>('project-1', 'ticket-1')
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.unarchive', {
      projectId: 'project-1',
      id: 'ticket-1'
    })
  })

  it('routes ticket.detachWorktree through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(4)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.detachWorktree('worktree-1')).resolves.toBe(4)
    expect(request).toHaveBeenCalledWith('kanban.ticket.detachWorktree', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes ticket.move through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Moved board fix',
      column: 'review',
      sort_order: 42
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.move<typeof ticket>('project-1', 'ticket-1', 'review', 42)
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.move', {
      projectId: 'project-1',
      id: 'ticket-1',
      column: 'review',
      sortOrder: 42
    })
  })

  it('routes ticket.reorder through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.reorder('project-1', 'ticket-1', 42)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.ticket.reorder', {
      projectId: 'project-1',
      id: 'ticket-1',
      sortOrder: 42
    })
  })

  it('routes ticket.addTokens through the renderer RPC client', async () => {
    const ticket = {
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Token board fix',
      total_tokens: 128
    }
    const request = vi.fn().mockResolvedValue(ticket)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.addTokens<typeof ticket>('project-1', 'ticket-1', 128)
    ).resolves.toEqual(ticket)
    expect(request).toHaveBeenCalledWith('kanban.ticket.addTokens', {
      projectId: 'project-1',
      id: 'ticket-1',
      tokens: 128
    })
  })

  it('routes dependency.removeAll through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(2)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.dependency.removeAll('project-1', 'ticket-1')).resolves.toBe(2)
    expect(request).toHaveBeenCalledWith('kanban.dependency.removeAll', {
      projectId: 'project-1',
      id: 'ticket-1'
    })
  })

  it('routes dependency.add through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.dependency.add('project-1', 'ticket-1', 'ticket-2')).resolves.toEqual(
      result
    )
    expect(request).toHaveBeenCalledWith('kanban.dependency.add', {
      projectId: 'project-1',
      dependentId: 'ticket-1',
      blockerId: 'ticket-2'
    })
  })

  it('routes dependency.remove through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.dependency.remove('project-1', 'ticket-1', 'ticket-2')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('kanban.dependency.remove', {
      projectId: 'project-1',
      dependentId: 'ticket-1',
      blockerId: 'ticket-2'
    })
  })

  it('routes ticket.syncPR through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.syncPR('worktree-1', 42, 'https://github.com/acme/hive/pull/42')
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.ticket.syncPR', {
      worktreeId: 'worktree-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/hive/pull/42'
    })
  })

  it('routes ticket.clearPR through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.clearPR('worktree-1')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.ticket.clearPR', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes dependency.getForProject through the renderer RPC client', async () => {
    const dependencies = [
      {
        dependent_id: 'ticket-1',
        blocker_id: 'ticket-2'
      }
    ]
    const request = vi.fn().mockResolvedValue(dependencies)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.dependency.getForProject('project-1')).resolves.toEqual(dependencies)
    expect(request).toHaveBeenCalledWith('kanban.dependency.getForProject', {
      projectId: 'project-1'
    })
  })

  it('routes simpleMode.toggle through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.simpleMode.toggle('project-1', true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.simpleMode.toggle', {
      projectId: 'project-1',
      enabled: true
    })
  })

  it('routes ticket.getByProject through the renderer RPC client', async () => {
    const tickets = [
      {
        id: 'ticket-1',
        project_id: 'project-1',
        title: 'Fix the board',
        column: 'todo'
      }
    ]
    const request = vi.fn().mockResolvedValue(tickets)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.getByProject('project-1', true)).resolves.toEqual(tickets)
    expect(request).toHaveBeenCalledWith('kanban.ticket.getByProject', {
      projectId: 'project-1',
      includeArchived: true
    })
  })

  it('routes ticket.getBySession through the renderer RPC client', async () => {
    const tickets = [
      {
        id: 'ticket-1',
        project_id: 'project-1',
        current_session_id: 'session-1',
        title: 'Linked board fix'
      }
    ]
    const request = vi.fn().mockResolvedValue(tickets)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.getBySession('session-1')).resolves.toEqual(tickets)
    expect(request).toHaveBeenCalledWith('kanban.ticket.getBySession', {
      sessionId: 'session-1'
    })
  })

  it('routes ticket.attachPR through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      kanbanApi.ticket.attachPR('ticket-1', 'project-1', 42, 'https://github.com/acme/hive/pull/42')
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.ticket.attachPR', {
      ticketId: 'ticket-1',
      projectId: 'project-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/hive/pull/42'
    })
  })

  it('routes ticket.detachPR through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.ticket.detachPR('ticket-1', 'project-1')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('kanban.ticket.detachPR', {
      ticketId: 'ticket-1',
      projectId: 'project-1'
    })
  })

  it('routes config operations through the renderer RPC client', async () => {
    const config = {
      mode: 'markdown',
      markdown: {
        layout: 'single-folder',
        singleFolder: 'docs/kanban',
        statusFolders: {
          todo: 'docs/kanban/todo',
          in_progress: 'docs/kanban/in-progress',
          review: 'docs/kanban/review',
          done: 'docs/kanban/done'
        }
      }
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce('/tmp/kanban')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.config.get<typeof config>('project-1')).resolves.toEqual(config)
    await expect(kanbanApi.config.update('project-1', config.markdown)).resolves.toEqual(config)
    await expect(kanbanApi.config.setMode('project-1', 'markdown')).resolves.toEqual({
      success: true
    })
    await expect(kanbanApi.config.createFolders('project-1', config.markdown)).resolves.toEqual({
      success: true
    })
    await expect(kanbanApi.config.pickMarkdownFolder()).resolves.toBe('/tmp/kanban')

    expect(request).toHaveBeenNthCalledWith(1, 'kanban.config.get', { projectId: 'project-1' })
    expect(request).toHaveBeenNthCalledWith(2, 'kanban.config.update', {
      projectId: 'project-1',
      config: config.markdown
    })
    expect(request).toHaveBeenNthCalledWith(3, 'kanban.config.setMode', {
      projectId: 'project-1',
      mode: 'markdown'
    })
    expect(request).toHaveBeenNthCalledWith(4, 'kanban.config.createFolders', {
      projectId: 'project-1',
      config: config.markdown
    })
    expect(request).toHaveBeenNthCalledWith(5, 'kanban.config.pickMarkdownFolder', {})
  })

  it('routes diagnostics and watch operations through the renderer RPC client', async () => {
    const diagnostics = [
      {
        projectId: 'project-1',
        ticketId: 'ticket-1',
        filePath: '/tmp/ticket.md',
        kind: 'invalid_frontmatter',
        message: 'Invalid frontmatter',
        blocking: true
      }
    ]
    const request = vi
      .fn()
      .mockResolvedValueOnce(diagnostics)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)

    setRendererRpcClient({ request, subscribe })

    await expect(kanbanApi.diagnostics.get('project-1')).resolves.toEqual(diagnostics)
    await expect(kanbanApi.watch.start('project-1')).resolves.toEqual({ success: true })
    await expect(kanbanApi.watch.stop('project-1')).resolves.toEqual({ success: true })

    const callback = vi.fn()
    expect(kanbanApi.watch.onChanged(callback)).toBe(unsubscribe)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: 'kanban:markdown:changed',
      payload: { projectId: 'project-1', paths: ['/tmp/ticket.md'], eventTypes: ['change'] }
    })
    expect(callback).toHaveBeenCalledWith({
      projectId: 'project-1',
      paths: ['/tmp/ticket.md'],
      eventTypes: ['change']
    })

    expect(request).toHaveBeenNthCalledWith(1, 'kanban.diagnostics.get', {
      projectId: 'project-1'
    })
    expect(request).toHaveBeenNthCalledWith(2, 'kanban.watch.start', { projectId: 'project-1' })
    expect(request).toHaveBeenNthCalledWith(3, 'kanban.watch.stop', { projectId: 'project-1' })
  })
})
