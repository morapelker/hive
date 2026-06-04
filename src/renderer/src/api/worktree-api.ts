import type { ServerEvent } from '@shared/rpc/protocol'
import {
  WORKTREE_BRANCH_RENAMED_CHANNEL,
  WORKTREE_CREATED_CHANNEL,
  type WorktreeBranchRenamedEvent
} from '@shared/worktree-events'
import { getRendererRpcClient } from './rpc-client'

type WorktreeMutationResult = {
  success: boolean
  error?: string
}

type WorktreeRow = {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  branch_renamed: number
  last_message_at: number | null
  session_titles: string
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  attachments: string
  pinned: number
  context: string | null
  github_pr_number: number | null
  github_pr_url: string | null
  base_branch: string | null
  created_at: string
  last_accessed_at: string
}

type WorktreeCreateParams = {
  projectId: string
  projectPath: string
  projectName: string
}

type WorktreeCreateFromBranchParams = WorktreeCreateParams & {
  branchName: string
  prNumber?: number
  nameHint?: string
}

type WorktreeDeleteParams = {
  worktreeId: string
  worktreePath: string
  branchName: string
  projectPath: string
  archive: boolean
}

type WorktreeSyncParams = {
  projectId: string
  projectPath: string
}

type WorktreeDuplicateParams = WorktreeCreateParams & {
  sourceBranch: string
  sourceWorktreePath: string
  nameHint?: string
}

type WorktreeRenameBranchParams = {
  worktreeId: string
  worktreePath: string
  oldBranch: string
  newBranch: string
}

type WorktreeOpsResult = {
  success: boolean
  worktree?: WorktreeRow
  error?: string
  pullInfo?: {
    pulled: boolean
    updated: boolean
  }
}

type WorktreeContextResult = {
  success: boolean
  context?: string | null
  error?: string
}

type WorktreeBranchesResult = {
  success: boolean
  branches?: string[]
  currentBranch?: string
  error?: string
}

type RendererWorktreeCreatedEvent = {
  projectId: string
  worktree: WorktreeRow
}

const isWorktreeBranchRenamedEvent = (payload: unknown): payload is WorktreeBranchRenamedEvent =>
  !!payload &&
  typeof payload === 'object' &&
  'worktreeId' in payload &&
  typeof payload.worktreeId === 'string' &&
  'newBranch' in payload &&
  typeof payload.newBranch === 'string'

const isWorktreeRow = (payload: unknown): payload is WorktreeRow =>
  !!payload &&
  typeof payload === 'object' &&
  'id' in payload &&
  typeof payload.id === 'string' &&
  'project_id' in payload &&
  typeof payload.project_id === 'string' &&
  'name' in payload &&
  typeof payload.name === 'string' &&
  'branch_name' in payload &&
  typeof payload.branch_name === 'string' &&
  'path' in payload &&
  typeof payload.path === 'string' &&
  'status' in payload &&
  (payload.status === 'active' || payload.status === 'archived')

const isWorktreeCreatedEvent = (payload: unknown): payload is RendererWorktreeCreatedEvent =>
  !!payload &&
  typeof payload === 'object' &&
  'projectId' in payload &&
  typeof payload.projectId === 'string' &&
  'worktree' in payload &&
  isWorktreeRow(payload.worktree)

export const worktreeApi = {
  hasCommits: async (projectPath: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('worktreeOps.hasCommits', { projectPath }),
  branchExists: async (projectPath: string, branchName: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('worktreeOps.branchExists', {
      projectPath,
      branchName
    }),
  create: async (params: WorktreeCreateParams): Promise<WorktreeOpsResult> =>
    getRendererRpcClient().request<WorktreeOpsResult>('worktreeOps.create', params),
  createFromBranch: async (params: WorktreeCreateFromBranchParams): Promise<WorktreeOpsResult> =>
    getRendererRpcClient().request<WorktreeOpsResult>('worktreeOps.createFromBranch', {
      projectId: params.projectId,
      projectPath: params.projectPath,
      projectName: params.projectName,
      branchName: params.branchName,
      ...(params.prNumber === undefined ? {} : { prNumber: params.prNumber }),
      ...(params.nameHint === undefined ? {} : { nameHint: params.nameHint })
    }),
  delete: async (params: WorktreeDeleteParams): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.delete', params),
  sync: async (params: WorktreeSyncParams): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.sync', params),
  duplicate: async (params: WorktreeDuplicateParams): Promise<WorktreeOpsResult> =>
    getRendererRpcClient().request<WorktreeOpsResult>('worktreeOps.duplicate', params),
  exists: async (worktreePath: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('worktreeOps.exists', { worktreePath }),
  renameBranch: async (params: WorktreeRenameBranchParams): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.renameBranch', params),
  getContext: async (worktreeId: string): Promise<WorktreeContextResult> =>
    getRendererRpcClient().request<WorktreeContextResult>('worktreeOps.getContext', {
      worktreeId
    }),
  updateContext: async (
    worktreeId: string,
    context: string | null
  ): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.updateContext', {
      worktreeId,
      context
    }),
  getBranches: async (projectPath: string): Promise<WorktreeBranchesResult> =>
    getRendererRpcClient().request<WorktreeBranchesResult>('worktreeOps.getBranches', {
      projectPath
    }),
  openInTerminal: async (worktreePath: string): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.openInTerminal', {
      worktreePath
    }),
  openInEditor: async (worktreePath: string): Promise<WorktreeMutationResult> =>
    getRendererRpcClient().request<WorktreeMutationResult>('worktreeOps.openInEditor', {
      worktreePath
    }),
  onBranchRenamed: (callback: (event: WorktreeBranchRenamedEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(WORKTREE_BRANCH_RENAMED_CHANNEL, (event: ServerEvent) => {
      if (isWorktreeBranchRenamedEvent(event.payload)) {
        callback(event.payload)
      }
    }),
  onWorktreeCreated: (callback: (event: RendererWorktreeCreatedEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(WORKTREE_CREATED_CHANNEL, (event: ServerEvent) => {
      if (isWorktreeCreatedEvent(event.payload)) {
        callback(event.payload)
      }
    })
}
