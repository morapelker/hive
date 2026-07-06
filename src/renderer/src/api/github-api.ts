import {
  GITHUB_CLONE_PROGRESS_CHANNEL,
  isGithubCloneProgressEvent,
  type GithubCloneProgressEvent
} from '@shared/github-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { getRendererRpcClient } from './rpc-client'

export interface GithubRepo {
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  updatedAt: string
}

export interface GithubListRepositoriesResult {
  success: boolean
  repos: GithubRepo[]
  error?: string
}

export interface GithubCloneStartResult {
  success: boolean
  path?: string
  error?: string
}

export interface GithubCloneRepositoryParams {
  nameWithOwner: string
  parentPath: string
  operationId: string
}

export const githubApi = {
  listRepositories: async (): Promise<GithubListRepositoriesResult> =>
    getRendererRpcClient().request<GithubListRepositoriesResult>('githubOps.listRepositories', {}),
  cloneRepository: async (params: GithubCloneRepositoryParams): Promise<GithubCloneStartResult> =>
    getRendererRpcClient().request<GithubCloneStartResult>('githubOps.cloneRepository', params),
  cancelClone: async (operationId: string): Promise<{ success: boolean }> =>
    getRendererRpcClient().request<{ success: boolean }>('githubOps.cancelClone', {
      operationId
    }),
  onCloneProgress: (callback: (event: GithubCloneProgressEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(GITHUB_CLONE_PROGRESS_CHANNEL, (event: ServerEvent) => {
      if (isGithubCloneProgressEvent(event.payload)) {
        callback(event.payload)
      }
    })
}
