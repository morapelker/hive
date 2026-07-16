import { getRendererRpcClient } from './rpc-client'
import type { SessionSearchOptions } from '@shared/types/session'
import type { Setting } from '@shared/types/settings'
import type { ProjectSpaceAssignment, Space } from '@shared/types/space'
import type { Worktree } from '@shared/types/worktree'
import type { CustomProjectCommand } from '@shared/lib/custom-commands'

type SpaceCreateData = {
  name: string
  icon_type?: string
  icon_value?: string
}

type SpaceUpdateData = {
  name?: string
  icon_type?: string
  icon_value?: string
  sort_order?: number
}

type DiffCommentCreateData = {
  worktree_id: string
  file_path: string
  line_start: number
  line_end?: number | null
  anchor_text?: string | null
  anchor_context_before?: string | null
  anchor_context_after?: string | null
  body: string
}

type DiffCommentUpdateData = {
  body?: string
  line_start?: number
  line_end?: number | null
  anchor_text?: string | null
  anchor_context_before?: string | null
  anchor_context_after?: string | null
  is_outdated?: boolean
}

type ProjectCreateData = {
  name: string
  path: string
  description?: string | null
  tags?: string[] | null
  setup_script?: string | null
  run_script?: string | null
  archive_script?: string | null
  worktree_create_script?: string | null
  custom_commands?: CustomProjectCommand[] | null
}

type ProjectUpdateData = {
  name?: string
  description?: string | null
  tags?: string[] | null
  language?: string | null
  custom_icon?: string | null
  detected_icon?: string | null
  setup_script?: string | null
  run_script?: string | null
  archive_script?: string | null
  worktree_create_script?: string | null
  custom_commands?: CustomProjectCommand[] | null
  auto_assign_port?: boolean
  last_accessed_at?: string
}

type SessionCreateData = {
  worktree_id: string | null
  project_id: string
  connection_id?: string | null
  name?: string | null
  opencode_session_id?: string | null
  claude_session_id?: string | null
  agent_sdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'codex-cli' | 'terminal'
  mode?: 'build' | 'plan' | 'super-plan'
  session_type?: 'default' | 'board-assistant'
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
  pinned_to_board?: boolean
}

type SessionUpdateData = {
  name?: string | null
  status?: 'active' | 'completed' | 'error'
  opencode_session_id?: string | null
  claude_session_id?: string | null
  agent_sdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'codex-cli' | 'terminal'
  mode?: 'build' | 'plan' | 'super-plan'
  session_type?: 'default' | 'board-assistant'
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
  updated_at?: string
  completed_at?: string | null
  pinned_to_board?: boolean
}

type WorktreeUpdateModelData = {
  worktreeId: string
  modelProviderId: string
  modelId: string
  modelVariant?: string | null
}

type WorktreeUpdateData = {
  name?: string
  branch_name?: string
  status?: 'active' | 'archived'
  branch_renamed?: number
  last_message_at?: number | null
  last_model_provider_id?: string | null
  last_model_id?: string | null
  last_model_variant?: string | null
  pinned?: number
  github_pr_number?: number | null
  github_pr_url?: string | null
  teleported_to?: string | null
  last_accessed_at?: string
}

type WorktreeMutationResult = {
  success: boolean
  error?: string
}

type DbIndexRow = {
  name: string
  tbl_name: string
}

type WorktreeAttachmentData = {
  type: 'jira' | 'figma'
  url: string
  label: string
}

export const dbApi = {
  schemaVersion: async (): Promise<number> =>
    getRendererRpcClient().request<number>('db.schemaVersion'),
  tableExists: async (tableName: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('db.tableExists', { tableName }),
  getIndexes: async (): Promise<DbIndexRow[]> =>
    getRendererRpcClient().request<DbIndexRow[]>('db.getIndexes'),
  diffComment: {
    create: async <TResult>(data: DiffCommentCreateData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('db.diffComment.create', data),
    update: async <TResult>(id: string, data: DiffCommentUpdateData): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.diffComment.update', { id, data }),
    delete: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.diffComment.delete', { id }),
    clearAll: async (worktreeId: string): Promise<number> =>
      getRendererRpcClient().request<number>('db.diffComment.clearAll', { worktreeId }),
    list: async <TResult>(worktreeId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.diffComment.list', { worktreeId })
  },
  project: {
    get: async <TResult>(id: string): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.project.get', { id }),
    getByPath: async <TResult>(path: string): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.project.getByPath', { path }),
    create: async <TResult>(data: ProjectCreateData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('db.project.create', data),
    update: async <TResult>(id: string, data: ProjectUpdateData): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.project.update', { id, data }),
    delete: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.project.delete', { id }),
    touch: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.project.touch', { id }),
    getAll: async <TResult>(): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.project.getAll', {}),
    reorder: async (orderedIds: string[]): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.project.reorder', { orderedIds }),
    sortByLastMessage: async (): Promise<string[]> =>
      getRendererRpcClient().request<string[]>('db.project.sortByLastMessage', {})
  },
  setting: {
    get: async (key: string): Promise<string | null> =>
      getRendererRpcClient().request<string | null>('db.setting.get', { key }),
    set: async (key: string, value: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.setting.set', { key, value }),
    delete: async (key: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.setting.delete', { key }),
    getAll: async (): Promise<Setting[]> =>
      getRendererRpcClient().request<Setting[]>('db.setting.getAll', {})
  },
  space: {
    list: async <TResult = Space>(): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.space.list'),
    create: async (data: SpaceCreateData): Promise<Space> =>
      getRendererRpcClient().request<Space>('db.space.create', data),
    update: async (id: string, data: SpaceUpdateData): Promise<Space | null> =>
      getRendererRpcClient().request<Space | null>('db.space.update', { id, data }),
    delete: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.space.delete', { id }),
    assignProject: async (projectId: string, spaceId: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.space.assignProject', { projectId, spaceId }),
    removeProject: async (projectId: string, spaceId: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.space.removeProject', { projectId, spaceId }),
    reorder: async (orderedIds: string[]): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.space.reorder', { orderedIds }),
    getAllAssignments: async <TResult = ProjectSpaceAssignment>(): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.space.getAllAssignments')
  },
  session: {
    create: async <TResult>(data: SessionCreateData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('db.session.create', data),
    update: async <TResult>(id: string, data: SessionUpdateData): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.session.update', { id, data }),
    delete: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('db.session.delete', { id }),
    updateDraft: async (sessionId: string, draft: string | null): Promise<void> =>
      getRendererRpcClient().request<void>('db.session.updateDraft', { sessionId, draft }),
    getDraft: async (sessionId: string): Promise<string | null> =>
      getRendererRpcClient().request<string | null>('db.session.getDraft', { sessionId }),
    get: async <TResult>(id: string): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.session.get', { id }),
    getActiveByWorktree: async <TResult>(worktreeId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.session.getActiveByWorktree', { worktreeId }),
    getActiveByConnection: async <TResult>(connectionId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.session.getActiveByConnection', {
        connectionId
      }),
    getActiveBoardAssistant: async <TResult>(projectId: string): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.session.getActiveBoardAssistant', {
        projectId
      }),
    getPinnedSessions: async <TResult>(worktreeId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.session.getPinnedSessions', { worktreeId }),
    setPinnedToBoard: async <TResult>(
      sessionId: string,
      pinned: boolean
    ): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.session.setPinnedToBoard', {
        sessionId,
        pinned
      }),
    search: async <TResult>(options: SessionSearchOptions): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.session.search', options)
  },
  sessionMessage: {
    list: async <TResult>(sessionId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.sessionMessage.list', { sessionId })
  },
  sessionActivity: {
    list: async <TResult>(sessionId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.sessionActivity.list', { sessionId })
  },
  worktree: {
    get: async <TResult = Worktree>(id: string): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.worktree.get', { id }),
    update: async <TResult = Worktree>(
      id: string,
      data: WorktreeUpdateData
    ): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('db.worktree.update', { id, data }),
    getActiveByProject: async <TResult = Worktree>(projectId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.worktree.getActiveByProject', { projectId }),
    getPinned: async <TResult = Worktree>(): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('db.worktree.getPinned', {}),
    updateModel: async (
      params: WorktreeUpdateModelData
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'db.worktree.updateModel',
        params
      ),
    removeAttachment: async (
      worktreeId: string,
      attachmentId: string
    ): Promise<WorktreeMutationResult> =>
      getRendererRpcClient().request<WorktreeMutationResult>('db.worktree.removeAttachment', {
        worktreeId,
        attachmentId
      }),
    addAttachment: async (
      worktreeId: string,
      attachment: WorktreeAttachmentData
    ): Promise<WorktreeMutationResult> =>
      getRendererRpcClient().request<WorktreeMutationResult>('db.worktree.addAttachment', {
        worktreeId,
        attachment
      }),
    setPinned: async (
      worktreeId: string,
      pinned: boolean
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'db.worktree.setPinned',
        { worktreeId, pinned }
      ),
    touch: async (id: string): Promise<void> =>
      getRendererRpcClient().request<void>('db.worktree.touch', { id }),
    appendSessionTitle: async (
      worktreeId: string,
      title: string
    ): Promise<WorktreeMutationResult> =>
      getRendererRpcClient().request<WorktreeMutationResult>('db.worktree.appendSessionTitle', {
        worktreeId,
        title
      }),
    attachPR: async (
      worktreeId: string,
      prNumber: number,
      prUrl: string
    ): Promise<WorktreeMutationResult> =>
      getRendererRpcClient().request<WorktreeMutationResult>('db.worktree.attachPR', {
        worktreeId,
        prNumber,
        prUrl
      }),
    detachPR: async (worktreeId: string): Promise<WorktreeMutationResult> =>
      getRendererRpcClient().request<WorktreeMutationResult>('db.worktree.detachPR', {
        worktreeId
      }),
    getRecentlyActive: async (cutoffMs: number): Promise<Worktree[]> =>
      getRendererRpcClient().request<Worktree[]>('db.worktree.getRecentlyActive', { cutoffMs })
  }
}
