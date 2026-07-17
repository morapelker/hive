import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'

import type { MemberAssessment } from '../connection-pr'

let request: ReturnType<typeof vi.fn>
let useGitStore: typeof import('@/stores/useGitStore').useGitStore
let connectionPr: typeof import('../connection-pr')

const memberA = {
  worktree_id: 'wt-a',
  project_id: 'proj-a',
  project_name: 'alpha',
  worktree_path: '/repo/a',
  worktree_branch: 'feat-a'
}
const memberB = {
  worktree_id: 'wt-b',
  project_id: 'proj-b',
  project_name: 'beta',
  worktree_path: '/repo/b',
  worktree_branch: 'feat-b'
}
const memberC = {
  worktree_id: 'wt-c',
  project_id: 'proj-c',
  project_name: 'gamma',
  worktree_path: '/repo/c',
  worktree_branch: 'feat-c'
}

function seedStores(): void {
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'proj-a',
        [
          { id: 'wt-a-default', path: '/proj/a', branch_name: 'main', is_default: true },
          { id: 'wt-a', path: '/repo/a', branch_name: 'feat-a', is_default: false }
        ]
      ],
      [
        'proj-b',
        [
          { id: 'wt-b-default', path: '/proj/b', branch_name: 'develop', is_default: true },
          { id: 'wt-b', path: '/repo/b', branch_name: 'feat-b', is_default: false }
        ]
      ],
      [
        'proj-c',
        [
          { id: 'wt-c-default', path: '/proj/c', branch_name: 'main', is_default: true },
          { id: 'wt-c', path: '/repo/c', branch_name: 'feat-c', is_default: false }
        ]
      ]
    ])
  } as never)
  useProjectStore.setState({
    projects: [
      { id: 'proj-a', path: '/proj/a' },
      { id: 'proj-b', path: '/proj/b' },
      { id: 'proj-c', path: '/proj/c' }
    ]
  } as never)
}

interface MockSpec {
  hasUncommitted?: Record<string, boolean>
  commitCount?: Record<string, number>
  branchAhead?: Record<string, number>
  overrides?: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>
}

function mockResponses(spec: MockSpec = {}): void {
  request.mockImplementation((method: string, params: Record<string, unknown>) => {
    const path = params?.worktreePath as string
    const override = spec.overrides?.[method]
    if (override !== undefined) {
      const value = typeof override === 'function' ? override(params) : override
      if (value instanceof Error) return Promise.reject(value)
      return Promise.resolve(value)
    }
    switch (method) {
      case 'gitOps.getRemoteUrl':
        return Promise.resolve({ success: true, url: 'https://github.com/acme/x.git' })
      case 'gitOps.hasUncommittedChanges':
        return Promise.resolve(spec.hasUncommitted?.[path] ?? false)
      case 'gitOps.getRangeDiff':
        return Promise.resolve({
          commitSummary: '',
          diffSummary: '',
          diffPatch: '',
          commitCount: spec.commitCount?.[path] ?? 0
        })
      case 'gitOps.getBranchInfo':
        return Promise.resolve({
          success: true,
          branch: {
            name: 'feat',
            tracking: null,
            ahead: spec.branchAhead?.[path] ?? 0,
            behind: 0
          }
        })
      case 'gitOps.getFileStatuses':
        return Promise.resolve({ success: true, files: [] })
      case 'gitOps.needsPush':
        return Promise.resolve(true)
      case 'gitOps.push':
        return Promise.resolve({ success: true, pushed: true })
      case 'gitOps.generatePRContent':
        return Promise.resolve({ success: true, title: 'AI title', body: 'AI body' })
      case 'gitOps.createPR':
        return Promise.resolve({
          success: true,
          url: `https://github.com/acme/x/pull/42`,
          number: 42
        })
      case 'gitOps.commit':
        return Promise.resolve({ success: true, commitHash: 'abc1234' })
      case 'db.worktree.attachPR':
      case 'kanban.ticket.syncPR':
        return Promise.resolve({ success: true })
      default:
        return Promise.resolve([])
    }
  })
}

function callsTo(method: string): unknown[][] {
  return request.mock.calls.filter(([m]) => m === method)
}

function notifications(): Array<Record<string, unknown>> {
  return usePRNotificationStore.getState().notifications as unknown as Array<
    Record<string, unknown>
  >
}

function makeAssessment(overrides: Partial<MemberAssessment> = {}): MemberAssessment {
  return {
    worktreeId: 'wt-a',
    worktreePath: '/repo/a',
    projectId: 'proj-a',
    projectName: 'alpha',
    projectPath: '/proj/a',
    branchName: 'feat-a',
    isDefaultWorktree: false,
    isGitHub: true,
    hasUncommitted: false,
    commitsAhead: 1,
    trackingAhead: 0,
    defaultBase: 'main',
    attachedPR: null,
    assessmentFailed: false,
    ...overrides
  }
}

describe('connection-pr', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })
    ;({ useGitStore } = await import('@/stores/useGitStore'))
    connectionPr = await import('../connection-pr')
    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      attachedPR: new Map(),
      creatingPRByWorktreeId: new Map(),
      isCommitting: false
    })
    usePRNotificationStore.setState({ notifications: [] })
    seedStores()
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  describe('assessConnectionMembers', () => {
    it('classifies members by changes and commits ahead', async () => {
      mockResponses({
        hasUncommitted: { '/repo/a': true },
        commitCount: { '/repo/b': 2 }
      })

      const assessments = await connectionPr.assessConnectionMembers([memberA, memberB, memberC])
      const byId = new Map(assessments.map((a) => [a.worktreeId, a]))

      const a = byId.get('wt-a')!
      const b = byId.get('wt-b')!
      const c = byId.get('wt-c')!

      expect(connectionPr.isPRWorthy(a)).toBe(true)
      expect(connectionPr.isArchivePromptable(a)).toBe(false)
      expect(connectionPr.isPRWorthy(b)).toBe(true)
      expect(connectionPr.isPRWorthy(c)).toBe(false)
      expect(connectionPr.isArchivePromptable(c)).toBe(true)
      expect(a.isGitHub).toBe(true)
      expect(b.defaultBase).toBe('develop')
      expect(b.projectPath).toBe('/proj/b')
    })

    it('never marks default worktrees as archive promptable', async () => {
      mockResponses()

      const assessments = await connectionPr.assessConnectionMembers([
        {
          worktree_id: 'wt-a-default',
          project_id: 'proj-a',
          project_name: 'alpha',
          worktree_path: '/proj/a',
          worktree_branch: 'main'
        }
      ])

      expect(assessments[0].isDefaultWorktree).toBe(true)
      expect(connectionPr.isArchivePromptable(assessments[0])).toBe(false)
    })

    it('blocks archive prompts when the tracking branch is ahead despite a zero range diff', async () => {
      mockResponses({ branchAhead: { '/repo/c': 3 } })

      const assessments = await connectionPr.assessConnectionMembers([memberC])

      expect(assessments[0].commitsAhead).toBe(0)
      expect(assessments[0].trackingAhead).toBe(3)
      expect(connectionPr.isArchivePromptable(assessments[0])).toBe(false)
    })

    it('prefers the persisted PR target branch as the default base', async () => {
      mockResponses()
      useGitStore.setState({ prTargetBranch: new Map([['wt-a', 'origin/release']]) })

      const assessments = await connectionPr.assessConnectionMembers([memberA])

      expect(assessments[0].defaultBase).toBe('release')
      expect(request).toHaveBeenCalledWith('gitOps.getRangeDiff', {
        worktreePath: '/repo/a',
        baseBranch: 'release'
      })
    })

    it('marks members whose assessment fails without prompting them', async () => {
      mockResponses({
        overrides: {
          'gitOps.getRangeDiff': (params) =>
            params.worktreePath === '/repo/c' ? new Error('git blew up') : undefined
        }
      })
      // Fall through to defaults for other members
      const assessments = await connectionPr.assessConnectionMembers([memberC])

      expect(assessments[0].assessmentFailed).toBe(true)
      expect(connectionPr.isPRWorthy(assessments[0])).toBe(false)
      expect(connectionPr.isArchivePromptable(assessments[0])).toBe(false)
    })
  })

  describe('commitConnectionMembers', () => {
    it('commits each member and isolates failures', async () => {
      mockResponses({
        overrides: {
          'gitOps.commit': (params) =>
            params.worktreePath === '/repo/a'
              ? { success: false, error: 'boom' }
              : { success: true, commitHash: 'def5678' }
        }
      })

      const results = await connectionPr.commitConnectionMembers(
        [makeAssessment(), makeAssessment({ worktreeId: 'wt-b', worktreePath: '/repo/b' })],
        'shared message'
      )

      expect(callsTo('gitOps.commit')).toHaveLength(2)
      expect(results.get('wt-a')).toMatchObject({ success: false, error: 'boom' })
      expect(results.get('wt-b')).toMatchObject({ success: true })
    })
  })

  describe('createConnectionPRs', () => {
    it('creates a PR per included member with the project name as prefix', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [{ assessment: makeAssessment(), baseBranch: 'main', include: true }],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(request).toHaveBeenCalledWith('gitOps.createPR', {
        worktreePath: '/repo/a',
        baseBranch: 'main',
        title: 'AI title',
        body: 'AI body'
      })
      expect(notifications()).toHaveLength(1)
      expect(notifications()[0]).toMatchObject({
        status: 'success',
        message: 'alpha: Pull request #42 created',
        worktreeId: 'wt-a'
      })
    })

    it('isolates a failing member from the others', async () => {
      mockResponses({
        overrides: {
          'gitOps.push': (params) =>
            params.worktreePath === '/repo/a'
              ? { success: false, error: 'no upstream' }
              : { success: true, pushed: true }
        }
      })

      await connectionPr.createConnectionPRs({
        plans: [
          { assessment: makeAssessment(), baseBranch: 'main', include: true },
          {
            assessment: makeAssessment({
              worktreeId: 'wt-b',
              worktreePath: '/repo/b',
              projectName: 'beta',
              projectPath: '/proj/b'
            }),
            baseBranch: 'develop',
            include: true
          }
        ],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(callsTo('gitOps.createPR')).toHaveLength(1)
      const byWorktree = new Map(notifications().map((n) => [n.worktreeId, n]))
      expect(byWorktree.get('wt-a')).toMatchObject({ status: 'error' })
      expect(byWorktree.get('wt-b')).toMatchObject({ status: 'success' })
    })

    it('pushes updates instead of creating for members with an attached PR', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [
          {
            assessment: makeAssessment({
              attachedPR: { number: 7, url: 'https://github.com/acme/x/pull/7' }
            }),
            baseBranch: 'main',
            include: true
          }
        ],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(callsTo('gitOps.createPR')).toHaveLength(0)
      expect(callsTo('gitOps.push')).toHaveLength(1)
      expect(notifications()[0]).toMatchObject({
        status: 'info',
        message: 'alpha: Pushed updates to PR #7',
        prNumber: 7,
        prUrl: 'https://github.com/acme/x/pull/7'
      })
    })

    it('skips non-GitHub members with an informational card', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [
          {
            assessment: makeAssessment({ isGitHub: false, hasUncommitted: true }),
            baseBranch: 'main',
            include: false
          }
        ],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(callsTo('gitOps.createPR')).toHaveLength(0)
      expect(callsTo('gitOps.push')).toHaveLength(0)
      expect(notifications()[0]).toMatchObject({ status: 'info', worktreeId: 'wt-a' })
      expect(String(notifications()[0].message)).toContain('no GitHub remote')
    })

    it('does nothing for members the user excluded', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [{ assessment: makeAssessment(), baseBranch: 'main', include: false }],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(callsTo('gitOps.createPR')).toHaveLength(0)
      expect(notifications()).toHaveLength(0)
    })

    it('warns for included members that ended up with no commits ahead', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [
          { assessment: makeAssessment({ commitsAhead: 0 }), baseBranch: 'main', include: true }
        ],
        ineligible: [],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      expect(callsTo('gitOps.createPR')).toHaveLength(0)
      expect(notifications()[0]).toMatchObject({ status: 'warning', worktreeId: 'wt-a' })
    })

    it('emits archive prompts for clean members after the batch settles', async () => {
      mockResponses()

      await connectionPr.createConnectionPRs({
        plans: [{ assessment: makeAssessment(), baseBranch: 'main', include: true }],
        ineligible: [
          makeAssessment({
            worktreeId: 'wt-c',
            worktreePath: '/repo/c',
            projectName: 'gamma',
            hasUncommitted: false,
            commitsAhead: 0
          })
        ],
        title: '',
        body: '',
        provider: 'claude-code'
      })

      const prompt = notifications().find((n) => n.worktreeId === 'wt-c')
      expect(prompt).toMatchObject({
        status: 'info',
        message: 'Nothing to PR in gamma',
        showArchiveButton: true
      })
    })
  })
})
