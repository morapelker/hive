import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { DatabaseService } from '../../../src/main/db/database'

describe('Session 2: Kanban CRUD', () => {
  let db: InstanceType<typeof DatabaseService>
  let cleanup: () => void
  let projectId: string

  beforeEach(() => {
    const testDir = join(tmpdir(), 'hive-test-' + randomUUID())
    mkdirSync(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    db = new DatabaseService(dbPath)
    db.init()

    cleanup = (): void => {
      db.close()
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }

    // Create a test project for all kanban ticket tests
    const project = db.createProject({ name: 'Kanban CRUD Test Project', path: '/kanban-crud-test' })
    projectId = project.id
  })

  afterEach(() => {
    if (cleanup) {
      cleanup()
    }
  })

  // --- createKanbanTicket ---

  test('createKanbanTicket returns ticket with generated id and timestamps', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'My First Ticket'
    })

    expect(ticket).toBeDefined()
    expect(ticket.id).toBeTruthy()
    expect(typeof ticket.id).toBe('string')
    expect(ticket.title).toBe('My First Ticket')
    expect(ticket.project_id).toBe(projectId)
    expect(ticket.created_at).toBeTruthy()
    expect(ticket.updated_at).toBeTruthy()
    // Timestamps should be valid ISO strings
    expect(new Date(ticket.created_at).toISOString()).toBe(ticket.created_at)
    expect(new Date(ticket.updated_at).toISOString()).toBe(ticket.updated_at)
  })

  test('createKanbanTicket sets defaults: column=todo, sort_order=0, plan_ready=false', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Defaults Test'
    })

    expect(ticket.column).toBe('todo')
    expect(ticket.sort_order).toBe(0)
    expect(ticket.plan_ready).toBe(false)
    expect(ticket.attachments).toEqual([])
    expect(ticket.description).toBeNull()
    expect(ticket.current_session_id).toBeNull()
    expect(ticket.worktree_id).toBeNull()
    expect(ticket.mode).toBeNull()
  })

  test('createKanbanTicket accepts optional fields', () => {
    const worktree = db.createWorktree({
      project_id: projectId,
      name: 'crud-wt',
      branch_name: 'crud-wt',
      path: '/kanban-crud-test/wt'
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: projectId,
      name: 'CRUD Session'
    })

    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Full Ticket',
      description: '# Hello\nMarkdown description',
      attachments: [{ path: '/file.ts', type: 'file' }],
      column: 'in_progress',
      sort_order: 5.5,
      current_session_id: session.id,
      worktree_id: worktree.id,
      mode: 'build',
      plan_ready: true
    })

    expect(ticket.title).toBe('Full Ticket')
    expect(ticket.description).toBe('# Hello\nMarkdown description')
    expect(ticket.attachments).toEqual([{ path: '/file.ts', type: 'file' }])
    expect(ticket.column).toBe('in_progress')
    expect(ticket.sort_order).toBe(5.5)
    expect(ticket.current_session_id).toBe(session.id)
    expect(ticket.worktree_id).toBe(worktree.id)
    expect(ticket.mode).toBe('build')
    expect(ticket.plan_ready).toBe(true)
  })

  test('createKanbanTicketBatch creates tickets and dependency links atomically', () => {
    const result = db.createKanbanTicketBatch({
      drafts: [
        {
          draft_key: 'schema',
          project_id: projectId,
          title: 'Create schema'
        },
        {
          draft_key: 'ui',
          project_id: projectId,
          title: 'Build UI',
          depends_on: ['schema']
        }
      ]
    })

    expect(result.tickets).toHaveLength(2)
    expect(result.dependencies).toHaveLength(1)

    const uiTicket = result.tickets.find((ticket) => ticket.title === 'Build UI')
    const schemaTicket = result.tickets.find((ticket) => ticket.title === 'Create schema')
    expect(uiTicket).toBeDefined()
    expect(schemaTicket).toBeDefined()

    const blockers = db.getBlockersForTicket(uiTicket!.id)
    expect(blockers).toHaveLength(1)
    expect(blockers[0].id).toBe(schemaTicket!.id)
  })

  test('createKanbanTicketBatch rejects cyclic draft graphs without creating tickets', () => {
    expect(() =>
      db.createKanbanTicketBatch({
        drafts: [
          {
            draft_key: 'a',
            project_id: projectId,
            title: 'Draft A',
            depends_on: ['b']
          },
          {
            draft_key: 'b',
            project_id: projectId,
            title: 'Draft B',
            depends_on: ['a']
          }
        ]
      })
    ).toThrow(/cycle/i)

    expect(db.getKanbanTicketsByProject(projectId)).toEqual([])
  })

  // --- getKanbanTicket ---

  test('getKanbanTicket returns null for non-existent id', () => {
    const ticket = db.getKanbanTicket('non-existent-id')
    expect(ticket).toBeNull()
  })

  test('getKanbanTicket returns mapped ticket with boolean plan_ready and parsed attachments', () => {
    const created = db.createKanbanTicket({
      project_id: projectId,
      title: 'Get Test',
      attachments: [{ path: '/a.ts', type: 'file' }],
      plan_ready: true
    })

    const fetched = db.getKanbanTicket(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(created.id)
    expect(fetched!.title).toBe('Get Test')
    // plan_ready should be boolean true, not integer 1
    expect(fetched!.plan_ready).toBe(true)
    expect(typeof fetched!.plan_ready).toBe('boolean')
    // attachments should be parsed array, not JSON string
    expect(Array.isArray(fetched!.attachments)).toBe(true)
    expect(fetched!.attachments).toEqual([{ path: '/a.ts', type: 'file' }])
  })

  // --- getKanbanTicketsByProject ---

  test('getKanbanTicketsByProject returns only tickets for that project', () => {
    const otherProject = db.createProject({ name: 'Other Project', path: '/other-project' })

    db.createKanbanTicket({ project_id: projectId, title: 'Ticket A' })
    db.createKanbanTicket({ project_id: projectId, title: 'Ticket B' })
    db.createKanbanTicket({ project_id: otherProject.id, title: 'Other Ticket' })

    const tickets = db.getKanbanTicketsByProject(projectId)
    expect(tickets).toHaveLength(2)
    expect(tickets.every((t) => t.project_id === projectId)).toBe(true)
  })

  test('getKanbanTicketsByProject returns tickets sorted by column then sort_order', () => {
    // Create tickets in different columns with different sort orders
    db.createKanbanTicket({ project_id: projectId, title: 'Done-2', column: 'done', sort_order: 2 })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'Todo-1',
      column: 'todo',
      sort_order: 1
    })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'Todo-0',
      column: 'todo',
      sort_order: 0
    })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'InProgress-0',
      column: 'in_progress',
      sort_order: 0
    })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'Done-1',
      column: 'done',
      sort_order: 1
    })

    const tickets = db.getKanbanTicketsByProject(projectId)
    const titles = tickets.map((t) => t.title)

    // Should be sorted by column (alphabetical: done, in_progress, todo), then sort_order
    expect(titles).toEqual(['Done-1', 'Done-2', 'InProgress-0', 'Todo-0', 'Todo-1'])
  })

  test('getKanbanTicketsByProject returns empty array for project with no tickets', () => {
    const tickets = db.getKanbanTicketsByProject(projectId)
    expect(tickets).toEqual([])
  })

  // --- updateKanbanTicket ---

  test('updateKanbanTicket modifies only specified fields', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Original Title',
      description: 'Original description'
    })

    const updated = db.updateKanbanTicket(ticket.id, { title: 'Updated Title' })
    expect(updated).toBeDefined()
    expect(updated!.title).toBe('Updated Title')
    // description should remain unchanged
    expect(updated!.description).toBe('Original description')
    // column should remain unchanged
    expect(updated!.column).toBe('todo')
  })

  test('updateKanbanTicket updates the updated_at timestamp', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Timestamp Test'
    })
    const originalUpdatedAt = ticket.updated_at

    const updated = db.updateKanbanTicket(ticket.id, { title: 'New Title' })
    expect(updated).toBeDefined()
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true)
  })

  test('updateKanbanTicket returns null for non-existent id', () => {
    const result = db.updateKanbanTicket('non-existent', { title: 'Nope' })
    expect(result).toBeNull()
  })

  test('updateKanbanTicket can update plan_ready and attachments', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Complex Update'
    })

    const updated = db.updateKanbanTicket(ticket.id, {
      plan_ready: true,
      attachments: [{ path: '/new.ts', type: 'file' }],
      mode: 'plan'
    })

    expect(updated!.plan_ready).toBe(true)
    expect(updated!.attachments).toEqual([{ path: '/new.ts', type: 'file' }])
    expect(updated!.mode).toBe('plan')
  })

  // --- deleteKanbanTicket ---

  test('deleteKanbanTicket returns true on success, false on non-existent', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Delete Me'
    })

    expect(db.deleteKanbanTicket(ticket.id)).toBe(true)
    // Should be gone
    expect(db.getKanbanTicket(ticket.id)).toBeNull()
    // Deleting again should return false
    expect(db.deleteKanbanTicket(ticket.id)).toBe(false)
    // Non-existent id
    expect(db.deleteKanbanTicket('non-existent')).toBe(false)
  })

  // --- moveKanbanTicket ---

  test('moveKanbanTicket updates column and sort_order', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Move Me',
      column: 'todo',
      sort_order: 0
    })

    const moved = db.moveKanbanTicket(ticket.id, 'in_progress', 3.5)
    expect(moved).toBeDefined()
    expect(moved!.column).toBe('in_progress')
    expect(moved!.sort_order).toBe(3.5)

    // Verify persisted
    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched!.column).toBe('in_progress')
    expect(fetched!.sort_order).toBe(3.5)
  })

  test('moveKanbanTicket returns null for non-existent id', () => {
    const result = db.moveKanbanTicket('non-existent', 'done', 0)
    expect(result).toBeNull()
  })

  // --- reorderKanbanTicket ---

  test('reorderKanbanTicket updates only sort_order', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Reorder Me',
      column: 'todo',
      sort_order: 0
    })

    db.reorderKanbanTicket(ticket.id, 7.25)

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched!.sort_order).toBe(7.25)
    // Column should NOT change
    expect(fetched!.column).toBe('todo')
  })

  // --- getKanbanTicketsBySession ---

  test('getKanbanTicketsBySession returns tickets referencing that session', () => {
    const worktree = db.createWorktree({
      project_id: projectId,
      name: 'session-wt',
      branch_name: 'session-wt',
      path: '/kanban-crud-test/session-wt'
    })
    const session1 = db.createSession({
      worktree_id: worktree.id,
      project_id: projectId,
      name: 'Session 1'
    })
    const session2 = db.createSession({
      worktree_id: worktree.id,
      project_id: projectId,
      name: 'Session 2'
    })

    db.createKanbanTicket({
      project_id: projectId,
      title: 'Ticket for S1',
      current_session_id: session1.id
    })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'Ticket for S2',
      current_session_id: session2.id
    })
    db.createKanbanTicket({
      project_id: projectId,
      title: 'Ticket no session'
    })

    const s1Tickets = db.getKanbanTicketsBySession(session1.id)
    expect(s1Tickets).toHaveLength(1)
    expect(s1Tickets[0].title).toBe('Ticket for S1')

    const s2Tickets = db.getKanbanTicketsBySession(session2.id)
    expect(s2Tickets).toHaveLength(1)
    expect(s2Tickets[0].title).toBe('Ticket for S2')
  })

  test('getKanbanTicketsBySession returns empty array when no tickets reference session', () => {
    const tickets = db.getKanbanTicketsBySession('non-existent-session')
    expect(tickets).toEqual([])
  })

  test('detachWorktreeFromTickets clears worktree_id but preserves PR metadata for matching tickets only', () => {
    const worktreeA = db.createWorktree({
      project_id: projectId,
      name: 'detach-a',
      branch_name: 'detach-a',
      path: '/kanban-crud-test/detach-a'
    })
    const worktreeB = db.createWorktree({
      project_id: projectId,
      name: 'detach-b',
      branch_name: 'detach-b',
      path: '/kanban-crud-test/detach-b'
    })

    const target = db.createKanbanTicket({
      project_id: projectId,
      title: 'Attached to A',
      worktree_id: worktreeA.id,
      github_pr_number: 101,
      github_pr_url: 'https://github.com/acme/repo/pull/101'
    })
    const untouched = db.createKanbanTicket({
      project_id: projectId,
      title: 'Attached to B',
      worktree_id: worktreeB.id,
      github_pr_number: 202,
      github_pr_url: 'https://github.com/acme/repo/pull/202'
    })

    const changes = db.detachWorktreeFromTickets(worktreeA.id)
    expect(changes).toBe(1)

    const detached = db.getKanbanTicket(target.id)
    expect(detached!.worktree_id).toBeNull()
    expect(detached!.github_pr_number).toBe(101)
    expect(detached!.github_pr_url).toBe('https://github.com/acme/repo/pull/101')

    const stillAttached = db.getKanbanTicket(untouched.id)
    expect(stillAttached!.worktree_id).toBe(worktreeB.id)
    expect(stillAttached!.github_pr_number).toBe(202)
    expect(stillAttached!.github_pr_url).toBe('https://github.com/acme/repo/pull/202')
  })

  // --- updateProjectSimpleMode ---

  test('updateProjectSimpleMode toggles the kanban_simple_mode column', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (db as any)['db']

    // Initially should be 0
    const before = rawDb
      .prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?')
      .get(projectId) as { kanban_simple_mode: number }
    expect(before.kanban_simple_mode).toBe(0)

    // Enable
    db.updateProjectSimpleMode(projectId, true)
    const enabled = rawDb
      .prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?')
      .get(projectId) as { kanban_simple_mode: number }
    expect(enabled.kanban_simple_mode).toBe(1)

    // Disable
    db.updateProjectSimpleMode(projectId, false)
    const disabled = rawDb
      .prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?')
      .get(projectId) as { kanban_simple_mode: number }
    expect(disabled.kanban_simple_mode).toBe(0)
  })

  // --- mapKanbanTicketRow edge cases ---

  test('mapKanbanTicketRow handles empty attachments JSON correctly', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Empty Attachments'
    })

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched!.attachments).toEqual([])
    expect(Array.isArray(fetched!.attachments)).toBe(true)
  })

  test('mapKanbanTicketRow handles plan_ready false correctly', () => {
    const ticket = db.createKanbanTicket({
      project_id: projectId,
      title: 'Plan Not Ready'
    })

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched!.plan_ready).toBe(false)
    expect(typeof fetched!.plan_ready).toBe('boolean')
  })
})
