import { describe, expect, it } from 'vitest'
import { getQueuedWorktreeId, isTicketLinkedToSidebarTarget } from './sidebar-hover-highlight'

const ticket = { project_id: 'p1', worktree_id: 'wt1', pending_launch_config: null }

describe('isTicketLinkedToSidebarTarget', () => {
  it('returns false when nothing is hovered', () => {
    expect(isTicketLinkedToSidebarTarget(ticket, null)).toBe(false)
  })

  it('matches tickets of the hovered project', () => {
    expect(isTicketLinkedToSidebarTarget(ticket, { kind: 'project', id: 'p1' })).toBe(true)
    expect(isTicketLinkedToSidebarTarget(ticket, { kind: 'project', id: 'p2' })).toBe(false)
  })

  it('matches tickets running on the hovered worktree', () => {
    expect(isTicketLinkedToSidebarTarget(ticket, { kind: 'worktree', id: 'wt1' })).toBe(true)
    expect(isTicketLinkedToSidebarTarget(ticket, { kind: 'worktree', id: 'wt2' })).toBe(false)
  })

  it('matches tickets queued to launch on the hovered worktree', () => {
    const queued = {
      project_id: 'p1',
      worktree_id: null,
      pending_launch_config: JSON.stringify({ worktree: { type: 'existing', worktreeId: 'wt9' } })
    }
    expect(isTicketLinkedToSidebarTarget(queued, { kind: 'worktree', id: 'wt9' })).toBe(true)
    expect(isTicketLinkedToSidebarTarget(queued, { kind: 'worktree', id: 'wt1' })).toBe(false)
  })

  it('leaves connection targets to the caller', () => {
    expect(isTicketLinkedToSidebarTarget(ticket, { kind: 'connection', id: 'c1' })).toBe(false)
  })
})

describe('getQueuedWorktreeId', () => {
  it('returns null for no config, new-worktree launches and malformed JSON', () => {
    expect(getQueuedWorktreeId({ pending_launch_config: null })).toBeNull()
    expect(
      getQueuedWorktreeId({
        pending_launch_config: JSON.stringify({ worktree: { type: 'new', sourceBranch: 'main' } })
      })
    ).toBeNull()
    expect(getQueuedWorktreeId({ pending_launch_config: '{not json' })).toBeNull()
  })
})
