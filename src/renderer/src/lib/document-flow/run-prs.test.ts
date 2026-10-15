/**
 * The PR button of a run's ticket: one pull request per integration branch (a git run's one,
 * a connection run's one per member) into the branch it was cut from, through the same
 * pipeline a ticket's PR uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRun } from '@/components/document-flow/test-fixtures'
import type { DocumentRunMember } from '@shared/types/document-flow'
import { useGitStore } from '@/stores/useGitStore'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { createDocumentRunPRs, documentRunPRTargets } from './run-prs'

const gitApi = vi.hoisted(() => ({
  getRemoteUrl: vi.fn(),
  getRangeDiff: vi.fn(),
  needsPush: vi.fn(),
  push: vi.fn()
}))
const pipeline = vi.hoisted(() => ({ runCreatePRPipeline: vi.fn() }))

vi.mock('@/api/git-api', () => ({ gitApi }))
vi.mock('@/lib/pr-pipeline', () => pipeline)

const initialGitState = useGitStore.getState()
const initialNotificationState = usePRNotificationStore.getState()
const initialProjectState = useProjectStore.getState()

const MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'origin/master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

const gitRun = () =>
  makeRun({
    status: 'completed',
    title: 'Checkout redesign',
    base_branch: 'origin/main',
    base_sha: '1111111aaaaaaa',
    integration_branch: 'doc-checkout-redesign',
    integration_worktree_id: 'wt-int',
    integration_worktree_path: '/worktrees/shop--doc-checkout-redesign'
  })

const connectionRun = () =>
  makeRun({
    status: 'completed',
    project_id: 'conn-project',
    title: 'Checkout redesign',
    base_branch: 'main + master',
    integration_branch: 'doc-checkout',
    integration_connection_id: 'conn-int',
    integration_connection_path: '/connections/doc-checkout',
    members: MEMBERS
  })

beforeEach(() => {
  gitApi.getRemoteUrl.mockResolvedValue({ url: 'https://github.com/acme/shop.git' })
  gitApi.getRangeDiff.mockResolvedValue({ commitCount: 3 })
  gitApi.needsPush.mockResolvedValue(false)
  pipeline.runCreatePRPipeline.mockImplementation(async (options) => {
    usePRNotificationStore.getState().update(options.notifId, { status: 'success' })
    return { ok: true, prNumber: 12, prUrl: 'https://github.com/acme/shop/pull/12' }
  })
})

afterEach(() => {
  vi.resetAllMocks()
  useGitStore.setState(initialGitState, true)
  usePRNotificationStore.setState(initialNotificationState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('documentRunPRTargets', () => {
  it('is empty until the run has an integration branch', () => {
    expect(documentRunPRTargets(makeRun(), [])).toEqual([])
  })

  it('is the one integration worktree of a git run, into its base without the remote prefix', () => {
    expect(
      documentRunPRTargets(gitRun(), [{ id: 'project-1', path: '/repo/shop' }])
    ).toEqual([
      {
        worktreeId: 'wt-int',
        worktreePath: '/worktrees/shop--doc-checkout-redesign',
        projectId: 'project-1',
        projectName: null,
        projectPath: '/repo/shop',
        baseBranch: 'main',
        baseSha: '1111111aaaaaaa',
        branchName: 'doc-checkout-redesign'
      }
    ])
  })

  it('is one per member of a connection run, each into its own base branch', () => {
    expect(documentRunPRTargets(connectionRun(), []).map((t) => [t.projectName, t.baseBranch]))
      .toEqual([
        ['Web', 'main'],
        ['API', 'master']
      ])
  })
})

describe('createDocumentRunPRs', () => {
  it('runs the PR pipeline from the integration worktree of a git run, titled after the run', async () => {
    useProjectStore.setState({
      projects: [{ id: 'project-1', path: '/repo/shop' } as never]
    })

    const results = await createDocumentRunPRs(gitRun())

    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledTimes(1)
    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-int',
        worktreePath: '/worktrees/shop--doc-checkout-redesign',
        projectPath: '/repo/shop',
        baseBranch: 'main',
        title: '',
        body: '',
        fallbackTitle: 'Checkout redesign',
        labelPrefix: ''
      })
    )
    expect(results).toEqual([
      expect.objectContaining({ ok: true, prNumber: 12, prUrl: 'https://github.com/acme/shop/pull/12' })
    ])
    // "Anything to PR?" is counted from the base commit: the bare base name may not resolve
    // locally, and an unresolvable ref counts as 0 rather than failing.
    expect(gitApi.getRangeDiff).toHaveBeenCalledWith(
      '/worktrees/shop--doc-checkout-redesign',
      '1111111aaaaaaa'
    )
    // One notification card, started as loading and driven to the pipeline's result.
    const notifications = usePRNotificationStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ status: 'success', worktreeId: 'wt-int' })
    // The remote was looked up once and remembered.
    expect(gitApi.getRemoteUrl).toHaveBeenCalledWith('/worktrees/shop--doc-checkout-redesign')
    expect(useGitStore.getState().remoteInfo.get('wt-int')?.supportsPR).toBe(true)
    expect(useGitStore.getState().creatingPRByWorktreeId.get('wt-int')).toBeFalsy()
  })

  it('creates one PR per member of a connection run, prefixed with the member name', async () => {
    const results = await createDocumentRunPRs(connectionRun())

    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledTimes(2)
    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-web-int',
        projectPath: '/repo/web',
        baseBranch: 'main',
        labelPrefix: 'Web: '
      })
    )
    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-api-int',
        projectPath: '/repo/api',
        baseBranch: 'master',
        labelPrefix: 'API: '
      })
    )
    expect(results.map((r) => [r.target.projectName, r.ok])).toEqual([
      ['Web', true],
      ['API', true]
    ])
  })

  it('pushes updates instead for a branch that already has a PR', async () => {
    useGitStore.getState().setAttachedPR('wt-int', {
      number: 7,
      url: 'https://github.com/acme/shop/pull/7'
    })
    gitApi.needsPush.mockResolvedValue(true)
    gitApi.push.mockResolvedValue({ success: true })

    const results = await createDocumentRunPRs(gitRun())

    expect(pipeline.runCreatePRPipeline).not.toHaveBeenCalled()
    expect(gitApi.push).toHaveBeenCalledWith('/worktrees/shop--doc-checkout-redesign')
    expect(results).toEqual([
      expect.objectContaining({ ok: true, existing: true, prNumber: 7 })
    ])
    expect(usePRNotificationStore.getState().notifications[0]).toMatchObject({
      status: 'info',
      message: 'Pushed updates to PR #7',
      prUrl: 'https://github.com/acme/shop/pull/7'
    })
  })

  it('skips a repository without a GitHub or GitLab remote, and one with nothing to PR', async () => {
    gitApi.getRemoteUrl.mockImplementation(async (path: string) => ({
      url: path.includes('web') ? 'https://example.com/acme/web.git' : 'https://github.com/acme/api.git'
    }))
    gitApi.getRangeDiff.mockResolvedValue({ commitCount: 0 })

    const results = await createDocumentRunPRs(connectionRun())

    expect(pipeline.runCreatePRPipeline).not.toHaveBeenCalled()
    expect(results.map((r) => r.ok)).toEqual([false, false])
    expect(usePRNotificationStore.getState().notifications.map((n) => n.message)).toEqual([
      'Web: no GitHub or GitLab remote — PR skipped',
      'API: nothing to PR — no commits ahead of master'
    ])
  })

  it('lets the members fail independently', async () => {
    pipeline.runCreatePRPipeline.mockImplementation(async (options) =>
      options.worktreeId === 'wt-web-int'
        ? { ok: false, error: 'gh: boom' }
        : { ok: true, prNumber: 3, prUrl: 'https://github.com/acme/api/pull/3' }
    )

    const results = await createDocumentRunPRs(connectionRun())

    expect(results.map((r) => [r.target.projectName, r.ok, r.prNumber ?? r.error])).toEqual([
      ['Web', false, 'gh: boom'],
      ['API', true, 3]
    ])
  })

  it('skips the "anything to PR?" check when the base commit is unknown', async () => {
    useProjectStore.setState({ projects: [{ id: 'project-1', path: '/repo/shop' } as never] })
    gitApi.getRangeDiff.mockResolvedValue({ commitCount: 0 })

    await createDocumentRunPRs({ ...gitRun(), base_sha: null })

    expect(gitApi.getRangeDiff).not.toHaveBeenCalled()
    expect(pipeline.runCreatePRPipeline).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a run that was not launched', async () => {
    expect(await createDocumentRunPRs(makeRun())).toEqual([])
    expect(pipeline.runCreatePRPipeline).not.toHaveBeenCalled()
  })
})
