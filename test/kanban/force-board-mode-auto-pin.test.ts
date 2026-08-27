import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autoPinForBoardPrompt, resolveAutoPinMode } from '@/lib/auto-pin'
import { isForceBoardMode } from '@/api/hive-enterprise/client'

let mockSettings: Record<string, unknown> = {}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) => (selector ? selector(mockSettings) : mockSettings),
    {
      getState: () => mockSettings
    }
  )
}))

const mockPinWorktree = vi.fn().mockResolvedValue(undefined)
const mockIsWorktreePinned = vi.fn().mockReturnValue(false)

vi.mock('@/stores/usePinnedStore', () => ({
  usePinnedStore: {
    getState: () => ({
      pinWorktree: mockPinWorktree,
      isWorktreePinned: mockIsWorktreePinned
    })
  }
}))

const mockGetDefaultWorktree = vi.fn()
const mockWorktreesByProject = new Map<string, { id: string }[]>([
  ['project-1', [{ id: 'base-worktree-1' }, { id: 'feature-worktree-1' }]]
])

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: () => ({
      worktreesByProject: mockWorktreesByProject,
      getDefaultWorktree: mockGetDefaultWorktree,
      loadWorktrees: vi.fn().mockResolvedValue(undefined)
    })
  }
}))

const policyOn = {
  hiveAuthToken: 'token-1',
  hiveOrganizationId: 'org-1',
  hiveOrganizationForceBoardMode: true
}
const policyOff = {
  hiveAuthToken: null,
  hiveOrganizationId: null,
  hiveOrganizationForceBoardMode: false
}

describe('isForceBoardMode', () => {
  it('is false unless logged in to an org with the policy enabled', () => {
    expect(isForceBoardMode(policyOn)).toBe(true)
    expect(isForceBoardMode({ ...policyOn, hiveAuthToken: null })).toBe(false)
    expect(isForceBoardMode({ ...policyOn, hiveOrganizationId: null })).toBe(false)
    expect(isForceBoardMode({ ...policyOn, hiveOrganizationForceBoardMode: false })).toBe(false)
  })
})

describe('resolveAutoPinMode under org Force board mode', () => {
  it('forces root-branch whatever the local mode is', () => {
    for (const mode of ['off', 'root-branch', 'current-branch'] as const) {
      expect(resolveAutoPinMode({ ...policyOn, autoPinOnBoardPrompt: mode })).toBe('root-branch')
    }
  })

  it('passes the local mode through when the policy is off', () => {
    for (const mode of ['off', 'root-branch', 'current-branch'] as const) {
      expect(resolveAutoPinMode({ ...policyOff, autoPinOnBoardPrompt: mode })).toBe(mode)
    }
  })
})

describe('autoPinForBoardPrompt under org Force board mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWorktreePinned.mockReturnValue(false)
    mockGetDefaultWorktree.mockReturnValue({ id: 'base-worktree-1' })
    mockSettings = { autoPinOnBoardPrompt: 'off', ...policyOff }
  })

  it('does not pin when the local setting is off and the policy is off', async () => {
    await autoPinForBoardPrompt({ projectId: 'project-1' })

    expect(mockPinWorktree).not.toHaveBeenCalled()
  })

  it('pins the base worktree with the local setting off when the policy is on', async () => {
    mockSettings = { autoPinOnBoardPrompt: 'off', ...policyOn }

    await autoPinForBoardPrompt({ projectId: 'project-1' })

    expect(mockPinWorktree).toHaveBeenCalledWith('base-worktree-1')
  })

  it("pins the base worktree (not the session's) even in current-branch mode when the policy is on", async () => {
    mockSettings = { autoPinOnBoardPrompt: 'current-branch', ...policyOn }

    await autoPinForBoardPrompt({ projectId: 'project-1', worktreeId: 'feature-worktree-1' })

    expect(mockPinWorktree).toHaveBeenCalledTimes(1)
    expect(mockPinWorktree).toHaveBeenCalledWith('base-worktree-1')
  })

  it('still pins from the local setting alone', async () => {
    mockSettings = { autoPinOnBoardPrompt: 'root-branch', ...policyOff }

    await autoPinForBoardPrompt({ projectId: 'project-1' })

    expect(mockPinWorktree).toHaveBeenCalledWith('base-worktree-1')
  })

  it("pins the session's worktree in current-branch mode when the policy is off", async () => {
    mockSettings = { autoPinOnBoardPrompt: 'current-branch', ...policyOff }

    await autoPinForBoardPrompt({ projectId: 'project-1', worktreeId: 'feature-worktree-1' })

    expect(mockPinWorktree).toHaveBeenCalledWith('feature-worktree-1')
  })
})
