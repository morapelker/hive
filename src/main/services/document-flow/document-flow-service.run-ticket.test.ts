// @vitest-environment node
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunStatus } from '@shared/types/document-flow'
import { getRpcRequestContext, rpcRequestContext } from '../../../server/rpc/request-context'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_PROJECT_ID,
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type ServiceHarness,
  type TestRepo
} from './test-support'

// The run's own board ticket after launch: where it sits as the run ends, what deleting either
// side does to the other, and the startup repair for runs launched before runs had a ticket.

let restoreGitConfig: () => void
let repo: TestRepo
let harness: ServiceHarness
let integration: string

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

beforeEach(() => {
  repo = createTestRepo()
  harness = createServiceHarness({ repo })
  integration = repo.addWorktree('doc-factory', repo.baseSha)
  harness.worktrees.set('wt-integration', {
    id: 'wt-integration',
    path: integration,
    branch_name: 'doc-factory',
    status: 'active',
    base_branch: 'main'
  })
})

afterEach(() => {
  harness.cleanup()
  repo.cleanup()
})

/** A launched run on the integration worktree; with `ticket`, its board ticket in that column. */
function seedLaunched(
  options: {
    status?: DocumentRunStatus
    ticket?: 'in_progress' | 'review' | 'done' | null
    items?: NonNullable<Parameters<typeof seedRun>[1]>['items']
  } = {}
): string {
  const { status = 'running', ticket = 'in_progress' } = options
  const { run } = seedRun(harness, {
    run: {
      status,
      base_branch: 'main',
      base_sha: repo.baseSha,
      integration_branch: 'doc-factory',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: integration,
      started_at: new Date().toISOString()
    },
    items: options.items ?? [{ key: 'A1', status: 'merged' }]
  })
  if (ticket) {
    const id = `run-ticket-${run.id}`
    harness.boardTickets.set(id, { id, projectId: TEST_PROJECT_ID, column: ticket })
    harness.db.updateDocumentRun(run.id, { ticket_id: id })
  }
  return run.id
}

const ticketOf = (runId: string): string => `run-ticket-${runId}`
const columnOf = (runId: string): string | undefined =>
  harness.boardTickets.get(ticketOf(runId))?.column
/** `cancel` moves the ticket without making its caller wait. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('when a run ends', () => {
  it('moves the ticket of a finalized run from In Progress to Review', async () => {
    const runId = seedLaunched()

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'review' }
    ])
    expect(columnOf(runId)).toBe('review')
  })

  it('completes a run whose only unmerged tickets were skipped: skipping is not an issue', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'skipped' }
      ]
    })

    expect((await harness.service.finalize(runId)).run.status).toBe('completed')
    expect(columnOf(runId)).toBe('review')
  })

  it('moves it for a run that finished with issues too', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'needs_attention' }
      ]
    })

    expect((await harness.service.finalize(runId)).run.status).toBe('completed_with_issues')
    expect(columnOf(runId)).toBe('review')
  })

  it('moves the ticket of a cancelled run to Review', async () => {
    const runId = seedLaunched({ items: [{ key: 'A1', status: 'running' }] })

    expect(harness.service.cancel(runId).run.status).toBe('cancelled')
    await settle()

    expect(columnOf(runId)).toBe('review')
  })

  it('moves the ticket outside the calling request, so the caller’s board reloads too', async () => {
    const runId = seedLaunched()
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.moveTicket = async () => {
      contexts.push(getRpcRequestContext())
    }

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.finalize(runId)
    )

    expect(contexts).toEqual([undefined])
  })

  it.each(['review', 'done'] as const)(
    'leaves a ticket the user already moved to %s where it is',
    async (column) => {
      const runId = seedLaunched({ ticket: column })

      await harness.service.finalize(runId)

      expect(harness.ticketMoves).toEqual([])
      expect(columnOf(runId)).toBe(column)
    }
  )

  it('finishes a run whose ticket is gone or cannot be moved', async () => {
    const gone = seedLaunched()
    harness.boardTickets.delete(ticketOf(gone))
    expect((await harness.service.finalize(gone)).run.status).toBe('completed')

    const stuck = seedLaunched()
    harness.overrides.moveTicket = async () => {
      throw new Error('database is locked')
    }
    expect((await harness.service.finalize(stuck)).run.status).toBe('completed')
    expect(columnOf(stuck)).toBe('in_progress')
  })

  it('does not touch the ticket of a run that was only paused', async () => {
    const runId = seedLaunched()

    harness.service.updateRun(runId, { status: 'paused' })
    await settle()

    expect(harness.ticketMoves).toEqual([])
  })
})

describe('deleting', () => {
  it('deletes the ticket of a deleted run, outside the calling request', async () => {
    const runId = seedLaunched({ status: 'completed', ticket: 'review' })
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.deleteTicket = async (_projectId, ticketId) => {
      contexts.push(getRpcRequestContext())
      harness.deletedTickets.push(ticketId)
    }

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, async () => {
      expect(await harness.service.delete(runId)).toBe(true)
    })

    expect(harness.deletedTickets).toEqual([ticketOf(runId)])
    expect(contexts).toEqual([undefined])
    expect(harness.db.getDocumentRun(runId)).toBeNull()
  })

  it('still deletes a run whose ticket cannot be deleted', async () => {
    const runId = seedLaunched({ status: 'cancelled', ticket: 'review' })
    harness.overrides.deleteTicket = async () => {
      throw new Error('The card file is gone')
    }

    expect(await harness.service.delete(runId)).toBe(true)
    expect(harness.db.getDocumentRun(runId)).toBeNull()
  })

  it('deletes the run with its ticket when the ticket is deleted', async () => {
    const runId = seedLaunched({ status: 'completed_with_issues', ticket: 'review' })

    expect(
      await harness.service.deleteRunTicket(TEST_PROJECT_ID, ticketOf(runId), runId)
    ).toBe(true)

    expect(harness.db.getDocumentRun(runId)).toBeNull()
    expect(harness.boardTickets.has(ticketOf(runId))).toBe(false)
    expect(harness.published).toContainEqual({
      runId,
      projectId: TEST_PROJECT_ID,
      reason: 'deleted'
    })
    // Branches and worktrees stay.
    expect(repo.git(repo.projectPath, 'rev-parse', '--verify', 'refs/heads/doc-factory')).toBe(
      repo.baseSha
    )
    expect(repo.git(repo.projectPath, 'worktree', 'list').split('\n')).toHaveLength(2)
  })

  it.each(['running', 'paused'] as const)(
    'refuses to delete the ticket of a run that is %s',
    async (status) => {
      const runId = seedLaunched({ status })

      await expect(
        harness.service.deleteRunTicket(TEST_PROJECT_ID, ticketOf(runId), runId)
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'Cancel the run before deleting its ticket.'
      })

      expect(harness.db.getDocumentRun(runId)).not.toBeNull()
      expect(harness.deletedTickets).toEqual([])
    }
  )

  it('just deletes a ticket whose run is gone, or that is not the ticket of its run', async () => {
    harness.boardTickets.set('orphan', {
      id: 'orphan',
      projectId: TEST_PROJECT_ID,
      column: 'review'
    })
    expect(await harness.service.deleteRunTicket(TEST_PROJECT_ID, 'orphan', 'no-such-run')).toBe(
      true
    )
    expect(harness.boardTickets.has('orphan')).toBe(false)

    // A stray ticket naming a live run must not take the run down with it.
    const runId = seedLaunched()
    harness.boardTickets.set('stray', { id: 'stray', projectId: TEST_PROJECT_ID, column: 'todo' })
    expect(await harness.service.deleteRunTicket(TEST_PROJECT_ID, 'stray', runId)).toBe(true)
    expect(harness.db.getDocumentRun(runId)).not.toBeNull()
    expect(harness.boardTickets.has(ticketOf(runId))).toBe(true)
  })
})

describe('reconcileRunTickets', () => {
  it.each([
    ['running', 'in_progress'],
    ['paused', 'in_progress'],
    ['completed', 'review'],
    ['completed_with_issues', 'review'],
    ['cancelled', 'review']
  ] as const)(
    'gives a %s run from before runs had a ticket one in %s',
    async (status, column) => {
      const runId = seedLaunched({ status, ticket: null })

      await harness.service.reconcileRunTickets()

      const ticketId = harness.db.getDocumentRun(runId)?.ticket_id
      expect(ticketId).toBeTruthy()
      expect(harness.boardTickets.get(ticketId!)).toMatchObject({ column })
      expect(harness.ticketBatches.at(-1)?.drafts[0]).toMatchObject({
        column,
        worktree_id: 'wt-integration',
        external_provider: 'document-run',
        external_id: runId,
        external_url: '/specs/factory.html'
      })
    }
  )

  it('creates nothing the second time', async () => {
    seedLaunched({ status: 'completed', ticket: null })

    await harness.service.reconcileRunTickets()
    await harness.service.reconcileRunTickets()

    expect(harness.ticketBatches).toHaveLength(1)
  })

  it('leaves runs that never launched, and runs whose integration worktree is gone', async () => {
    seedRun(harness, { items: [{}] })
    seedRun(harness, { run: { status: 'extract_failed' } })
    const archived = seedLaunched({ status: 'completed', ticket: null })
    harness.worktrees.get('wt-integration')!.status = 'archived'

    await harness.service.reconcileRunTickets()

    expect(harness.ticketBatches).toEqual([])
    expect(harness.db.getDocumentRun(archived)?.ticket_id).toBeNull()

    harness.worktrees.delete('wt-integration')
    await harness.service.reconcileRunTickets()
    expect(harness.ticketBatches).toEqual([])
  })

  it('moves the ticket of a run that ended while the app was closed to Review', async () => {
    const ended = seedLaunched({ status: 'completed', ticket: 'in_progress' })
    const running = seedLaunched({ status: 'running', ticket: 'in_progress' })
    const moved = seedLaunched({ status: 'cancelled', ticket: 'done' })

    await harness.service.reconcileRunTickets()

    expect(columnOf(ended)).toBe('review')
    expect(columnOf(running)).toBe('in_progress')
    expect(columnOf(moved)).toBe('done')
    expect(harness.ticketBatches).toEqual([])
  })

  it('re-points ticket worktrees recorded against the integration branch at the base branch', async () => {
    const runId = seedLaunched({
      status: 'completed',
      items: [
        { key: 'A1', status: 'merged', worktree_id: 'wt-a1' },
        { key: 'A2', status: 'merged', worktree_id: 'wt-a2' },
        { key: 'A3', status: 'merged', worktree_id: 'wt-a3' },
        { key: 'A4', status: 'skipped' },
        { key: 'A5', status: 'merged', worktree_id: 'wt-gone' }
      ]
    })
    const worktree = (id: string, base: string | null): void => {
      harness.worktrees.set(id, { id, path: `/wt/${id}`, branch_name: id, base_branch: base })
    }
    worktree('wt-a1', 'doc-factory')
    // Launched after the change, or re-based by hand: already not the integration branch.
    worktree('wt-a2', 'main')
    worktree('wt-a3', 'release')

    await harness.service.reconcileRunTickets()

    expect(harness.baseBranchWrites).toEqual([{ worktreeId: 'wt-a1', baseBranch: 'main' }])
    // The integration worktree itself is not a ticket worktree.
    expect(harness.worktrees.get('wt-integration')?.base_branch).toBe('main')

    await harness.service.reconcileRunTickets()
    expect(harness.baseBranchWrites).toHaveLength(1)
    expect(harness.db.getDocumentRun(runId)).not.toBeNull()
  })

  it('re-points outside the calling request, so the caller’s worktrees reload too', async () => {
    seedLaunched({
      status: 'completed',
      ticket: 'review',
      items: [{ key: 'A1', status: 'merged', worktree_id: 'wt-a1' }]
    })
    harness.worktrees.set('wt-a1', {
      id: 'wt-a1',
      path: '/wt/wt-a1',
      branch_name: 'wt-a1',
      base_branch: 'doc-factory'
    })
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.setWorktreeBaseBranch = () => {
      contexts.push(getRpcRequestContext())
    }

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.reconcileRunTickets()
    )

    expect(contexts).toEqual([undefined])
  })

  it('gives no ticket to a run cancelled after its launch failed half-way', async () => {
    // The integration worktree was created, then the board refused the tickets.
    const { run } = seedRun(harness, {
      run: {
        status: 'preview',
        base_branch: 'main',
        base_sha: repo.baseSha,
        integration_branch: 'doc-factory',
        integration_worktree_id: 'wt-integration',
        integration_worktree_path: integration
      },
      items: [{}]
    })
    await harness.service.cancel(run.id)
    await settle()
    expect(harness.db.getDocumentRun(run.id)).toMatchObject({
      status: 'cancelled',
      started_at: null
    })

    await harness.service.reconcileRunTickets()

    expect(harness.ticketBatches).toEqual([])
    expect(harness.db.getDocumentRun(run.id)?.ticket_id).toBeNull()
  })

  it('goes on with the other runs when one cannot be repaired', async () => {
    const broken = seedLaunched({ status: 'completed', ticket: null })
    const fine = seedLaunched({ status: 'completed', ticket: null })
    harness.overrides.createTickets = async (_projectId, drafts) => {
      if (drafts[0].external_id === broken) throw new Error('database is locked')
      return { tickets: [{ id: 'ticket-fine' }] }
    }

    await expect(harness.service.reconcileRunTickets()).resolves.toBeUndefined()

    expect(harness.db.getDocumentRun(broken)?.ticket_id).toBeNull()
    expect(harness.db.getDocumentRun(fine)?.ticket_id).toBe('ticket-fine')
  })
})

describe('sourceFile', () => {
  it('reports the document the run was made from, and whether it is still on disk', async () => {
    const path = join(harness.scratch, 'spec.html')
    writeFileSync(path, '<h1>Spec</h1>')
    const { run } = seedRun(harness, { run: { source_path: path } })

    await expect(harness.service.sourceFile(run.id)).resolves.toEqual({ path, exists: true })

    rmSync(path)
    await expect(harness.service.sourceFile(run.id)).resolves.toEqual({ path, exists: false })
  })

  it('refuses an unknown run', async () => {
    await expect(harness.service.sourceFile('nope')).rejects.toThrow('The run was not found.')
  })
})
