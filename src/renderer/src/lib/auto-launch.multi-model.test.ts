import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoLaunchTicket } from './auto-launch'
import { launchTicketWithModel } from '@/lib/ticket-launch'
import { runMultiModelLaunch } from '@/lib/multi-model-launch'
import { useProjectStore } from '@/stores/useProjectStore'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/lib/ticket-launch', () => ({
  launchTicketWithModel: vi.fn()
}))

vi.mock('@/lib/multi-model-launch', () => ({
  runMultiModelLaunch: vi.fn()
}))

vi.mock('@/lib/auto-pin', () => ({
  autoPinBaseWorktree: vi.fn()
}))

const initialProjectState = useProjectStore.getState()

function setupProject(): void {
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/repo',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
}

const twoEntries = [
  { sdk: 'opencode' as const, model: { providerID: 'anthropic', modelID: 'opus' }, codexFastMode: false },
  { sdk: 'codex' as const, model: { providerID: 'codex', modelID: 'gpt-5.5' }, codexFastMode: false }
]

describe('autoLaunchTicket multi-model routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupProject()
    vi.mocked(launchTicketWithModel).mockResolvedValue({
      success: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1'
    })
    vi.mocked(runMultiModelLaunch).mockResolvedValue(undefined)
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
  })

  it('routes multi-entry + new worktree to runMultiModelLaunch', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Fix Login Bug',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'new', sourceBranch: 'main' },
        prompt: 'Implement the fix',
        mode: 'build',
        model: null,
        sdk: 'opencode',
        codexFastMode: false,
        goalMode: true,
        goalSuccessCriteria: 'Tests pass',
        models: twoEntries
      })
    })

    expect(runMultiModelLaunch).toHaveBeenCalledWith({
      ticket: { id: 'ticket-1', title: 'Fix Login Bug' },
      projectId: 'project-1',
      prompt: 'Implement the fix',
      mode: 'build',
      sourceBranch: 'main',
      goalMode: true,
      goalSuccessCriteria: 'Tests pass',
      entries: twoEntries
    })
    expect(launchTicketWithModel).not.toHaveBeenCalled()
  })

  it('keeps the single-path entries[0] behavior for multi-entry + existing worktree', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Fix Login Bug',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'existing', worktreeId: 'worktree-1' },
        prompt: 'Implement the fix',
        mode: 'build',
        model: null,
        sdk: 'opencode',
        codexFastMode: false,
        goalMode: false,
        goalSuccessCriteria: null,
        models: twoEntries
      })
    })

    expect(runMultiModelLaunch).not.toHaveBeenCalled()
    expect(launchTicketWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-1',
        projectId: 'project-1',
        worktree: { type: 'existing', worktreeId: 'worktree-1' },
        modelConfig: twoEntries[0]
      })
    )
  })

  it('single-entry configs never call runMultiModelLaunch, even with a new worktree', async () => {
    await autoLaunchTicket({
      id: 'ticket-1',
      project_id: 'project-1',
      title: 'Fix Login Bug',
      pending_launch_config: JSON.stringify({
        worktree: { type: 'new', sourceBranch: 'main' },
        prompt: 'Implement the fix',
        mode: 'build',
        model: { providerID: 'anthropic', modelID: 'opus' },
        sdk: 'opencode',
        codexFastMode: false,
        goalMode: false,
        goalSuccessCriteria: null
      })
    })

    expect(runMultiModelLaunch).not.toHaveBeenCalled()
    expect(launchTicketWithModel).toHaveBeenCalled()
  })
})
