import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMultiModelLaunch, type MultiModelLaunchPlan } from './multi-model-launch'
import { launchTicketWithModel } from '@/lib/ticket-launch'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUsageStore } from '@/stores/useUsageStore'
import type { KanbanTicket } from '../../../main/db/types'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/lib/ticket-launch', () => ({
  launchTicketWithModel: vi.fn()
}))

const initialKanbanState = useKanbanStore.getState()
const initialUsageState = useUsageStore.getState()
const initialSettingsState = useSettingsStore.getState()

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'existing-1',
    project_id: 'project-1',
    title: 'Existing ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 5,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: false,
    auto_approve_plan: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

function basePlan(overrides: Partial<MultiModelLaunchPlan> = {}): MultiModelLaunchPlan {
  return {
    ticket: { id: 'ticket-1', title: 'Fix Login Bug' },
    projectId: 'project-1',
    prompt: 'Implement the fix',
    mode: 'build',
    sourceBranch: 'main',
    goalMode: false,
    goalSuccessCriteria: null,
    entries: [
      {
        sdk: 'opencode',
        model: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
        codexFastMode: false
      },
      {
        sdk: 'codex',
        model: { providerID: 'codex', modelID: 'gpt-5.5-codex' },
        codexFastMode: true
      },
      {
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
        codexFastMode: false
      }
    ],
    clearPendingConfig: true,
    ...overrides
  }
}

function setupStores(existingTickets: KanbanTicket[] = [makeTicket()]): {
  updateTicket: ReturnType<typeof vi.fn>
  duplicateTicket: ReturnType<typeof vi.fn>
  fetchUsageForProvider: ReturnType<typeof vi.fn>
} {
  const updateTicket = vi.fn(async () => undefined)
  let dupCounter = 0
  const duplicateTicket = vi.fn(async (): Promise<KanbanTicket> => {
    dupCounter += 1
    return makeTicket({ id: `dup-${dupCounter}` })
  })
  const fetchUsageForProvider = vi.fn()

  useKanbanStore.setState({
    tickets: new Map([['project-1', existingTickets]]),
    updateTicket,
    duplicateTicket
  })
  useUsageStore.setState({ fetchUsageForProvider })
  // Guard against persisted per-provider defaults leaking in from localStorage
  // in the test environment (see ticket-launch.test.ts's identical guard).
  useSettingsStore.setState({ selectedModel: null, selectedModelByProvider: {} })

  return { updateTicket, duplicateTicket, fetchUsageForProvider }
}

describe('runMultiModelLaunch', () => {
  beforeAll(() => {
    // Absorb the useSettingsStore one-shot 200ms import timer so it cannot
    // null store state mid-test (see global constraints).
    return new Promise((resolve) => setTimeout(resolve, 220))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(launchTicketWithModel).mockResolvedValue({
      success: true,
      sessionId: 'session-x',
      worktreeId: 'worktree-x'
    })
  })

  afterEach(() => {
    useKanbanStore.setState(initialKanbanState, true)
    useUsageStore.setState(initialUsageState, true)
    useSettingsStore.setState(initialSettingsState, true)
  })

  it('makes all N tickets appear immediately with badge fields, a shared group id, and fractional sort orders', async () => {
    const { updateTicket, duplicateTicket } = setupStores()

    await runMultiModelLaunch(basePlan())

    // base = computeSortOrder([{sort_order: 5}], 0) = 5 - 1 = 4
    expect(updateTicket).toHaveBeenCalledTimes(1)
    const [originalId, originalProjectId, originalData] = updateTicket.mock.calls[0]
    expect(originalId).toBe('ticket-1')
    expect(originalProjectId).toBe('project-1')
    expect(originalData).toMatchObject({
      column: 'in_progress',
      sort_order: 4,
      mode: 'build',
      plan_ready: false,
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-5-20251101',
      model_variant: null,
      goal_mode: false,
      goal_success_criteria: null,
      pending_launch_config: null
    })
    const groupId = originalData.variant_group_id as string
    expect(typeof groupId).toBe('string')
    expect(groupId.length).toBeGreaterThan(0)

    expect(duplicateTicket).toHaveBeenCalledTimes(2)
    expect(duplicateTicket).toHaveBeenNthCalledWith(1, 'project-1', 'ticket-1', {
      column: 'in_progress',
      sort_order: 4 + 1 / 3,
      model_provider_id: 'codex',
      model_id: 'gpt-5.5-codex',
      model_variant: null,
      variant_group_id: groupId
    })
    expect(duplicateTicket).toHaveBeenNthCalledWith(2, 'project-1', 'ticket-1', {
      column: 'in_progress',
      sort_order: 4 + 2 / 3,
      model_provider_id: 'anthropic',
      model_id: 'sonnet',
      model_variant: 'high',
      variant_group_id: groupId
    })
  })

  it('falls back through resolveModelForSdk/FALLBACK_MODELS when an entry has no explicit model', async () => {
    const { updateTicket, duplicateTicket } = setupStores()

    await runMultiModelLaunch(
      basePlan({
        entries: [
          { sdk: 'opencode', model: { providerID: 'anthropic', modelID: 'opus' }, codexFastMode: false },
          { sdk: 'claude-code-cli', model: null, codexFastMode: false }
        ]
      })
    )

    // FALLBACK_MODELS['claude-code-cli'] = { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' }
    expect(duplicateTicket).toHaveBeenCalledWith(
      'project-1',
      'ticket-1',
      expect.objectContaining({
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: 'high'
      })
    )
    expect(updateTicket).toHaveBeenCalledTimes(1)
  })

  it('launches sequentially — the second launch does not start before the first resolves', async () => {
    setupStores()
    let firstResolved = false
    let secondStartedBeforeFirstResolved = false
    vi.mocked(launchTicketWithModel).mockImplementation(async (spec) => {
      if (spec.ticketId === 'ticket-1') {
        await new Promise((resolve) => setTimeout(resolve, 10))
        firstResolved = true
        return { success: true, sessionId: 's1', worktreeId: 'w1' }
      }
      if (!firstResolved) secondStartedBeforeFirstResolved = true
      return { success: true, sessionId: 's2', worktreeId: 'w2' }
    })

    await runMultiModelLaunch(basePlan())

    expect(secondStartedBeforeFirstResolved).toBe(false)
  })

  it('launches with the right worktree nameHints (title slug + model slug)', async () => {
    setupStores()

    await runMultiModelLaunch(basePlan())

    expect(launchTicketWithModel).toHaveBeenCalledTimes(3)
    const calls = vi.mocked(launchTicketWithModel).mock.calls
    expect(calls[0][0]).toMatchObject({
      ticketId: 'ticket-1',
      worktree: { type: 'new', sourceBranch: 'main', nameHint: 'fix-login-bug-claude-opus-4-5' },
      prompt: 'Implement the fix',
      mode: 'build',
      goalMode: false,
      goalSuccessCriteria: null
    })
    expect(calls[0][0].modelConfig).toEqual(basePlan().entries[0])
    expect(calls[0][0]).not.toHaveProperty('ticketUpdateExtras')

    expect(calls[1][0]).toMatchObject({
      ticketId: 'dup-1',
      worktree: { type: 'new', sourceBranch: 'main', nameHint: 'fix-login-bug-gpt-5-5-codex' }
    })
    expect(calls[2][0]).toMatchObject({
      ticketId: 'dup-2',
      worktree: { type: 'new', sourceBranch: 'main', nameHint: 'fix-login-bug-sonnet' }
    })
  })

  it('moves a failed launch back to To Do with cleared fields (keeping variant_group_id), toasts, and still launches the next entry', async () => {
    const { updateTicket } = setupStores([
      makeTicket({ id: 'existing-1', column: 'in_progress', sort_order: 5 }),
      makeTicket({ id: 'todo-1', column: 'todo', sort_order: 2 })
    ])
    vi.mocked(launchTicketWithModel).mockImplementation(async (spec) => {
      if (spec.ticketId === 'dup-1') return { success: false, error: 'boom' }
      return { success: true, sessionId: 's', worktreeId: 'w' }
    })

    await runMultiModelLaunch(basePlan())

    expect(toast.error).toHaveBeenCalledWith('Failed to launch gpt-5.5-codex: boom')

    // The failure-recovery updateTicket call is the second call (after the
    // initial "appears immediately" call for the original ticket).
    expect(updateTicket).toHaveBeenCalledTimes(2)
    const [failedId, failedProjectId, failedData] = updateTicket.mock.calls[1]
    expect(failedId).toBe('dup-1')
    expect(failedProjectId).toBe('project-1')
    expect(failedData).toEqual({
      column: 'todo',
      sort_order: 1, // computeSortOrder([{sort_order: 2}], 0) = 2 - 1 = 1
      current_session_id: null,
      worktree_id: null,
      plan_ready: false,
      mode: null,
      goal_mode: false,
      goal_success_criteria: null,
      model_provider_id: null,
      model_id: null,
      model_variant: null
    })
    expect(failedData).not.toHaveProperty('variant_group_id')

    // entry-2 (dup-2) still launched despite entry-1's failure.
    expect(launchTicketWithModel).toHaveBeenCalledTimes(3)
    expect(vi.mocked(launchTicketWithModel).mock.calls[2][0].ticketId).toBe('dup-2')
  })

  it('skips the launch for a model whose duplicateTicket call fails, but still launches the next entry', async () => {
    setupStores()
    const duplicateTicket = vi.fn(async (_projectId: string, _ticketId: string, overrides: unknown) => {
      const o = overrides as { model_id: string }
      if (o.model_id === 'gpt-5.5-codex') return null
      return makeTicket({ id: 'dup-2' })
    })
    useKanbanStore.setState({ duplicateTicket })

    await runMultiModelLaunch(basePlan())

    expect(toast.error).toHaveBeenCalledWith('Failed to duplicate ticket for gpt-5.5-codex')

    expect(launchTicketWithModel).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(launchTicketWithModel).mock.calls
    expect(calls[0][0].ticketId).toBe('ticket-1')
    expect(calls[1][0].ticketId).toBe('dup-2')
  })

  it('refreshes usage once per distinct SDK among entries, after the loop', async () => {
    const { fetchUsageForProvider } = setupStores()

    await runMultiModelLaunch(
      basePlan({
        entries: [
          { sdk: 'opencode', model: { providerID: 'anthropic', modelID: 'opus' }, codexFastMode: false },
          { sdk: 'opencode', model: { providerID: 'anthropic', modelID: 'sonnet' }, codexFastMode: false },
          { sdk: 'codex', model: { providerID: 'codex', modelID: 'gpt-5.5' }, codexFastMode: false }
        ]
      })
    )

    expect(fetchUsageForProvider).toHaveBeenCalledTimes(2)
    expect(fetchUsageForProvider).toHaveBeenNthCalledWith(1, 'anthropic')
    expect(fetchUsageForProvider).toHaveBeenNthCalledWith(2, 'openai')
  })
})
