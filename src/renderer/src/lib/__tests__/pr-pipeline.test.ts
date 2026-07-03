import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'

let request: ReturnType<typeof vi.fn>
let useGitStore: typeof import('@/stores/useGitStore').useGitStore
let runCreatePRPipeline: typeof import('../pr-pipeline').runCreatePRPipeline

const baseOptions = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/wt-1',
  projectPath: '/projects/one',
  baseBranch: 'main',
  title: '',
  body: '',
  fallbackTitle: 'feature-x',
  provider: 'claude-code' as const
}

function mockResponses(overrides: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
    'gitOps.needsPush': true,
    'gitOps.push': { success: true, pushed: true },
    'gitOps.generatePRContent': { success: true, title: 'AI title', body: 'AI body' },
    'gitOps.createPR': {
      success: true,
      url: 'https://github.com/acme/repo/pull/42',
      number: 42
    },
    'gitOps.getPRState': { success: true, state: 'OPEN', title: 'Existing PR title' },
    'db.worktree.attachPR': { success: true },
    'kanban.ticket.syncPR': { success: true }
  }
  const responses = { ...defaults, ...overrides }
  request.mockImplementation((method: string) => {
    if (method in responses) {
      const value = responses[method]
      if (value instanceof Error) return Promise.reject(value)
      return Promise.resolve(value)
    }
    return Promise.resolve([])
  })
}

function callsTo(method: string): unknown[][] {
  return request.mock.calls.filter(([m]) => m === method)
}

function lastNotification(): Record<string, unknown> {
  const notifications = usePRNotificationStore.getState().notifications
  return notifications[notifications.length - 1] as unknown as Record<string, unknown>
}

describe('runCreatePRPipeline', () => {
  let notifId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })
    ;({ useGitStore } = await import('@/stores/useGitStore'))
    ;({ runCreatePRPipeline } = await import('../pr-pipeline'))
    useGitStore.setState({
      attachedPR: new Map(),
      creatingPRByWorktreeId: new Map()
    })
    usePRNotificationStore.setState({ notifications: [] })
    notifId = usePRNotificationStore.getState().show({
      status: 'loading',
      message: 'Creating pull request...',
      worktreeId: 'wt-1'
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('pushes when needed, generates content, creates and attaches the PR', async () => {
    mockResponses()

    const result = await runCreatePRPipeline({ ...baseOptions, notifId })

    expect(callsTo('gitOps.push')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('gitOps.generatePRContent', {
      worktreePath: '/repo/wt-1',
      baseBranch: 'main',
      provider: 'claude-code'
    })
    expect(request).toHaveBeenCalledWith('gitOps.createPR', {
      worktreePath: '/repo/wt-1',
      baseBranch: 'main',
      title: 'AI title',
      body: 'AI body'
    })
    expect(request).toHaveBeenCalledWith('db.worktree.attachPR', {
      worktreeId: 'wt-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42'
    })
    expect(result).toEqual({
      ok: true,
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42'
    })
    expect(lastNotification()).toMatchObject({
      status: 'success',
      message: 'Pull request #42 created',
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42'
    })
    expect(useGitStore.getState().creatingPRByWorktreeId.has('wt-1')).toBe(false)
  })

  it('skips push and generation when nothing to push and content is provided', async () => {
    mockResponses({ 'gitOps.needsPush': false })

    await runCreatePRPipeline({
      ...baseOptions,
      title: 'My title',
      body: 'My body',
      notifId
    })

    expect(callsTo('gitOps.push')).toHaveLength(0)
    expect(callsTo('gitOps.generatePRContent')).toHaveLength(0)
    expect(request).toHaveBeenCalledWith('gitOps.createPR', {
      worktreePath: '/repo/wt-1',
      baseBranch: 'main',
      title: 'My title',
      body: 'My body'
    })
  })

  it('falls back to the branch name with a warning when generation fails', async () => {
    mockResponses({
      'gitOps.needsPush': false,
      'gitOps.generatePRContent': { success: false, error: 'model unavailable' }
    })

    const result = await runCreatePRPipeline({ ...baseOptions, notifId })

    expect(request).toHaveBeenCalledWith('gitOps.createPR', {
      worktreePath: '/repo/wt-1',
      baseBranch: 'main',
      title: 'feature-x',
      body: ''
    })
    expect(result.ok).toBe(true)
    expect(lastNotification()).toMatchObject({
      status: 'warning',
      message: 'PR #42 created with default content',
      description: 'model unavailable'
    })
  })

  it('attaches an existing PR from the structured already-exists result', async () => {
    mockResponses({
      'gitOps.needsPush': false,
      'gitOps.createPR': {
        success: false,
        error: 'a pull request already exists',
        number: 7,
        url: 'https://github.com/acme/repo/pull/7'
      }
    })

    const result = await runCreatePRPipeline({ ...baseOptions, notifId })

    expect(request).toHaveBeenCalledWith('db.worktree.attachPR', {
      worktreeId: 'wt-1',
      prNumber: 7,
      prUrl: 'https://github.com/acme/repo/pull/7'
    })
    expect(request).toHaveBeenCalledWith('gitOps.getPRState', {
      projectPath: '/projects/one',
      prNumber: 7
    })
    expect(result).toMatchObject({ ok: true, existing: true, prNumber: 7 })
    expect(lastNotification()).toMatchObject({
      status: 'info',
      message: 'PR #7 already exists',
      description: 'Attached to workspace',
      prTitle: 'Existing PR title'
    })
  })

  it('recovers the existing PR from the error message when unstructured', async () => {
    mockResponses({
      'gitOps.needsPush': false,
      'gitOps.createPR': {
        success: false,
        error:
          'a pull request for branch "feature-x" already exists:\nhttps://github.com/acme/repo/pull/12'
      }
    })

    const result = await runCreatePRPipeline({ ...baseOptions, notifId })

    expect(request).toHaveBeenCalledWith('db.worktree.attachPR', {
      worktreeId: 'wt-1',
      prNumber: 12,
      prUrl: 'https://github.com/acme/repo/pull/12'
    })
    expect(result).toMatchObject({ ok: true, existing: true, prNumber: 12 })
  })

  it('reports an error notification when the push fails', async () => {
    mockResponses({ 'gitOps.push': { success: false, error: 'no upstream' } })

    const result = await runCreatePRPipeline({ ...baseOptions, notifId })

    expect(result.ok).toBe(false)
    expect(callsTo('gitOps.createPR')).toHaveLength(0)
    expect(lastNotification()).toMatchObject({
      status: 'error',
      message: 'Failed to create pull request',
      description: 'no upstream'
    })
    expect(useGitStore.getState().creatingPRByWorktreeId.has('wt-1')).toBe(false)
  })

  it('prefixes notification messages with the label prefix', async () => {
    mockResponses({ 'gitOps.needsPush': false })

    await runCreatePRPipeline({ ...baseOptions, notifId, labelPrefix: 'web: ' })

    expect(lastNotification()).toMatchObject({
      status: 'success',
      message: 'web: Pull request #42 created'
    })
  })
})
