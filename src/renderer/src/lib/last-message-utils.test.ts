import { beforeEach, describe, expect, it, vi } from 'vitest'

// setLastMessageTime persists via dbApi; stub it so tests stay in-memory.
vi.mock('@/api/db-api', () => ({
  dbApi: {
    worktree: {
      update: vi.fn().mockResolvedValue(null)
    }
  }
}))

import { bumpWorktreeLastMessage } from './last-message-utils'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const PROJECT_ID = 'proj-1'
const DEFAULT_WT = 'wt-default'
const FEATURE_WT = 'wt-feature'

function makeWorktree(id: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    project_id: PROJECT_ID,
    name: id,
    branch_name: id,
    path: `/tmp/${id}`,
    status: 'active',
    is_default: isDefault,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    created_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    github_pr_number: null,
    github_pr_url: null
  }
}

beforeEach(() => {
  type WorktreesByProject = ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [PROJECT_ID, [makeWorktree(DEFAULT_WT, true), makeWorktree(FEATURE_WT, false)]]
    ]) as unknown as WorktreesByProject
  })
  useWorktreeStatusStore.setState({ lastMessageTimeByWorktree: {} })
})

describe('bumpWorktreeLastMessage default-worktree fan-out', () => {
  it('bumping a worktree also bumps the project default worktree', () => {
    const ts = 1_750_000_000_000
    bumpWorktreeLastMessage({ worktreeId: FEATURE_WT, timestamp: ts })

    const times = useWorktreeStatusStore.getState().lastMessageTimeByWorktree
    expect(times[FEATURE_WT]).toBe(ts)
    expect(times[DEFAULT_WT]).toBe(ts)
  })

  it('bumping the default worktree itself only bumps once', () => {
    const ts = 1_750_000_000_000
    bumpWorktreeLastMessage({ worktreeId: DEFAULT_WT, timestamp: ts })

    const times = useWorktreeStatusStore.getState().lastMessageTimeByWorktree
    expect(times[DEFAULT_WT]).toBe(ts)
    expect(times[FEATURE_WT]).toBeUndefined()
  })

  it('connection bumps fan out to each member project default', () => {
    const ts = 1_750_000_000_000
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          members: [{ worktree_id: FEATURE_WT, project_id: PROJECT_ID }]
        }
      ] as unknown as ReturnType<typeof useConnectionStore.getState>['connections']
    })

    bumpWorktreeLastMessage({ connectionId: 'conn-1', timestamp: ts })

    const times = useWorktreeStatusStore.getState().lastMessageTimeByWorktree
    expect(times[FEATURE_WT]).toBe(ts)
    expect(times[DEFAULT_WT]).toBe(ts)
  })
})
