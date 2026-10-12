import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunDetail,
  type DocumentRunMember
} from '@shared/types/document-flow'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { rememberedVerifyCommands, useDocumentFlowStore } from './useDocumentFlowStore'

const api = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))

const initialState = useDocumentFlowStore.getState()

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
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

const connectionDetail = (memberVerifyCommands: Record<string, string | null>): DocumentRunDetail =>
  makeDetail({
    id: 'run-conn',
    project_id: 'project-conn',
    status: 'running',
    members: MEMBERS,
    integration_connection_id: 'conn-int',
    config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: null, memberVerifyCommands }
  })

beforeEach(() => {
  useDocumentFlowStore.setState({
    runsById: {},
    prefs: { ...initialState.prefs, verifyCommandByProject: { other: 'make' } }
  })
})

afterEach(() => {
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialState, true)
})

describe('rememberedVerifyCommands', () => {
  it('remembers the command of a git project under its own id, none as ""', () => {
    const { run } = makeDetail({
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check' }
    })
    expect(rememberedVerifyCommands(run)).toEqual({ 'project-1': 'pnpm check' })
    expect(
      rememberedVerifyCommands(
        makeDetail({ config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: null } }).run
      )
    ).toEqual({ 'project-1': '' })
  })

  it('remembers one command per member of a connection run, under the member project ids', () => {
    const { run } = connectionDetail({ web: 'pnpm check' })
    // The connection project itself gets nothing: it has no command of its own.
    expect(rememberedVerifyCommands(run)).toEqual({ web: 'pnpm check', api: '' })
  })
})

describe('useDocumentFlowStore.startRun — remembered verify commands', () => {
  it('remembers a git run under the project id', async () => {
    const detail = makeDetail({
      status: 'running',
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check' }
    })
    api.start.mockResolvedValue(detail)

    await useDocumentFlowStore.getState().startRun(detail.run.id)

    expect(useDocumentFlowStore.getState().prefs.verifyCommandByProject).toEqual({
      other: 'make',
      'project-1': 'pnpm check'
    })
  })

  it('remembers a connection run per member, so each member finds its command again', async () => {
    const detail = connectionDetail({ web: 'pnpm typecheck', api: '' })
    api.start.mockResolvedValue(detail)

    await useDocumentFlowStore.getState().startRun(detail.run.id)

    const { prefs, runsById } = useDocumentFlowStore.getState()
    expect(prefs.verifyCommandByProject).toEqual({ other: 'make', web: 'pnpm typecheck', api: '' })
    expect(prefs.verifyCommandByProject).not.toHaveProperty('project-conn')
    expect(runsById['run-conn'].run.status).toBe('running')
  })
})
