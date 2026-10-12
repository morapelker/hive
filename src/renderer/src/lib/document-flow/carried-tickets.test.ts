import { describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { DocumentRunDetail, DocumentRunItemMember } from '@shared/types/document-flow'
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

  describe('on a connection run', () => {
    const members = (
      key: string,
      web: Partial<DocumentRunItemMember> = {},
      api: Partial<DocumentRunItemMember> = {}
    ): DocumentRunItemMember[] => [
      {
        project_id: 'p-web',
        worktree_id: `wt-${key}-web`,
        branch_name: key,
        pre_merge_sha: null,
        merge_sha: null,
        ...web
      },
      {
        project_id: 'p-api',
        worktree_id: `wt-${key}-api`,
        branch_name: key,
        pre_merge_sha: null,
        merge_sha: null,
        ...api
      }
    ]

    /** A1 merged in both members, A2 only in web; A3 is the queried ticket. */
    const connectionRun = (): DocumentRunDetail =>
      makeDetail(
        {
          id: 'run-c',
          status: 'completed',
          integration_connection_id: 'conn-int',
          members: [
            {
              project_id: 'p-web',
              project_name: 'Web',
              project_path: '/repo/web',
              symlink_name: 'web',
              base_branch: 'main',
              base_sha: 'b',
              integration_branch: 'doc',
              integration_worktree_id: 'wt-int-web',
              integration_worktree_path: '/w/int-web'
            },
            {
              project_id: 'p-api',
              project_name: 'Api',
              project_path: '/repo/api',
              symlink_name: 'api',
              base_branch: 'main',
              base_sha: 'b',
              integration_branch: 'doc',
              integration_worktree_id: 'wt-int-api',
              integration_worktree_path: '/w/int-api'
            }
          ]
        },
        [
          {
            key: 'A1',
            status: 'merged',
            merge_sha: 'web=m1w,api=m1a',
            ticket_id: 'ticket-A1',
            members: members('A1', { merge_sha: 'm1w' }, { merge_sha: 'm1a' })
          },
          {
            key: 'A2',
            status: 'merged',
            merge_sha: 'web=m2w',
            ticket_id: 'ticket-A2',
            members: members('A2', { merge_sha: 'm2w' }, { merge_sha: null })
          },
          {
            key: 'A3',
            status: 'merged',
            merge_sha: 'web=m3w,api=m3a',
            ticket_id: 'ticket-A3',
            members: members('A3', { merge_sha: 'm3w' }, { merge_sha: 'm3a' })
          }
        ]
      )

    it('finds the ticket by a member worktree and names the merges in that member only', async () => {
      const carried = await findCarriedRunTickets(
        { ...query, ticketId: 'ticket-other', worktreeId: 'wt-A3-api' },
        [connectionRun()],
        git({ [FEATURE]: ['m1a', 'm1w', 'm2w'], [BASE]: [] })
      )

      // A2 merged nothing in api: nothing of it can be on the api branch.
      expect(carried).toEqual(['A1'])
    })

    it('uses the web merges for the web worktree', async () => {
      expect(
        await findCarriedRunTickets(
          { ...query, ticketId: 'ticket-A3', worktreeId: 'wt-A3-web' },
          [connectionRun()],
          git({ [FEATURE]: ['m1w', 'm2w'], [BASE]: ['m1w'] })
        )
      ).toEqual(['A2'])
    })

    it('has nothing to say about a worktree of no member, even for the run’s own ticket', async () => {
      const isMerged = vi.fn(async () => true)

      expect(
        await findCarriedRunTickets(
          { ...query, ticketId: 'ticket-A3', worktreeId: 'wt-int-web' },
          [connectionRun()],
          isMerged
        )
      ).toEqual([])
      expect(isMerged).not.toHaveBeenCalled()
    })
  })
})
