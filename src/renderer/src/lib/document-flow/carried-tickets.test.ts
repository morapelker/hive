import { describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import { findCarriedRunTickets, type CarriedTicketsQuery } from './carried-tickets'

vi.mock('@/api/git-api', () => ({ gitApi: { isBranchMerged: vi.fn() } }))

const FEATURE = '/worktrees/a3'
const BASE = '/repo'

const query: CarriedTicketsQuery = {
  ticketId: 'ticket-A3',
  worktreeId: 'wt-A3',
  featureWorktreePath: FEATURE,
  baseWorktreePath: BASE
}

/** A1 and A2 merged before A3 was cut; A4 merged after; A5 never merged. */
const run = (): DocumentRunDetail =>
  makeDetail({ id: 'run-1', status: 'completed', base_branch: 'main' }, [
    { key: 'A1', status: 'merged', merge_sha: 'm1', ticket_id: 'ticket-A1', worktree_id: 'wt-A1' },
    { key: 'A2', status: 'merged', merge_sha: 'm2', ticket_id: 'ticket-A2', worktree_id: 'wt-A2' },
    { key: 'A3', status: 'merged', merge_sha: 'm3', ticket_id: 'ticket-A3', worktree_id: 'wt-A3' },
    { key: 'A4', status: 'merged', merge_sha: 'm4', ticket_id: 'ticket-A4', worktree_id: 'wt-A4' },
    { key: 'A5', status: 'needs_attention', merge_sha: null, ticket_id: 'ticket-A5' }
  ])

/** `reachable[path]` lists the commits that checkout's HEAD contains. */
const git =
  (reachable: Record<string, string[]>) =>
  async (path: string, ref: string): Promise<boolean> =>
    (reachable[path] ?? []).includes(ref)

describe('findCarriedRunTickets', () => {
  it('names the earlier tickets on the branch that the base branch does not have yet', async () => {
    const carried = await findCarriedRunTickets(
      query,
      [run()],
      git({ [FEATURE]: ['m1', 'm2'], [BASE]: [] })
    )

    expect(carried).toEqual(['A1', 'A2'])
  })

  it('names none once the integration branch is in the base branch', async () => {
    expect(
      await findCarriedRunTickets(
        query,
        [run()],
        git({ [FEATURE]: ['m1', 'm2'], [BASE]: ['m1', 'm2', 'm3', 'm4'] })
      )
    ).toEqual([])
  })

  it('names only the ones still missing when an earlier ticket was merged on its own', async () => {
    expect(
      await findCarriedRunTickets(query, [run()], git({ [FEATURE]: ['m1', 'm2'], [BASE]: ['m1'] }))
    ).toEqual(['A2'])
  })

  it('finds the ticket by its worktree when the ticket itself is another one', async () => {
    expect(
      await findCarriedRunTickets(
        { ...query, ticketId: 'ticket-follow-up' },
        [run()],
        git({ [FEATURE]: ['m1'], [BASE]: [] })
      )
    ).toEqual(['A1'])
  })

  it('has nothing to say about a ticket of no run, or about the run ticket itself', async () => {
    const isMerged = vi.fn(async () => true)

    expect(
      await findCarriedRunTickets(
        { ...query, ticketId: 'ticket-x', worktreeId: 'wt-x' },
        [run()],
        isMerged
      )
    ).toEqual([])
    expect(
      await findCarriedRunTickets(
        { ...query, ticketId: 'ticket-run', worktreeId: 'wt-integration' },
        [run()],
        isMerged
      )
    ).toEqual([])
    expect(isMerged).not.toHaveBeenCalled()
  })

  it('leaves out a ticket git cannot tell about', async () => {
    const isMerged = async (path: string, ref: string): Promise<boolean> => {
      if (ref === 'm1') throw new Error('bad object m1')
      return path === FEATURE
    }

    expect(await findCarriedRunTickets(query, [run()], isMerged)).toEqual(['A2', 'A4'])
  })
})
