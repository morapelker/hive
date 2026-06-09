import { getRendererRpcClient } from './rpc-client'
import type { SuggestionItem } from '@shared/types/setup-suggestions'

export interface ProjectValidationResult {
  success: boolean
  path?: string
  name?: string
  error?: string
}

export interface InitRepositoryResult {
  success: boolean
  error?: string
}

export interface PickProjectIconResult {
  success: boolean
  filename?: string
  error?: string
}

export interface RemoveProjectIconResult {
  success: boolean
  error?: string
}

export const projectApi = {
  openDirectoryDialog: async (): Promise<string | null> => {
    return getRendererRpcClient().request<string | null>('projectOps.openDirectoryDialog', {})
  },
  openPath: async (path: string): Promise<void> => {
    return getRendererRpcClient().request<void>('projectOps.openPath', { path })
  },
  showInFolder: async (path: string): Promise<void> => {
    return getRendererRpcClient().request<void>('projectOps.showInFolder', { path })
  },
  copyToClipboard: async (text: string): Promise<void> => {
    return getRendererRpcClient().request<void>('projectOps.copyToClipboard', { text })
  },
  readFromClipboard: async (): Promise<string> => {
    return getRendererRpcClient().request<string>('projectOps.readFromClipboard', {})
  },
  isGitRepository: async (path: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('projectOps.isGitRepository', { path }),
  validateProject: async (path: string): Promise<ProjectValidationResult> =>
    getRendererRpcClient().request<ProjectValidationResult>('projectOps.validateProject', { path }),
  detectLanguage: async (projectPath: string): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('projectOps.detectLanguage', {
      path: projectPath
    }),
  detectSetupSuggestions: async (projectPath: string): Promise<SuggestionItem[]> =>
    getRendererRpcClient().request<SuggestionItem[]>('projectOps.detectSetupSuggestions', {
      path: projectPath
    }),
  findXcworkspace: async (projectPath: string): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('projectOps.findXcworkspace', {
      path: projectPath
    }),
  isAndroidProject: async (projectPath: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('projectOps.isAndroidProject', {
      path: projectPath
    }),
  loadLanguageIcons: async (): Promise<Record<string, string>> =>
    getRendererRpcClient().request<Record<string, string>>('projectOps.loadLanguageIcons', {}),
  getProjectIconPath: async (filename: string): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('projectOps.getProjectIconPath', { filename }),
  getAbsoluteIconDataUrl: async (absolutePath: string): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('projectOps.getAbsoluteIconDataUrl', {
      path: absolutePath
    }),
  pickProjectIcon: async (projectId: string): Promise<PickProjectIconResult> => {
    return getRendererRpcClient().request<PickProjectIconResult>('projectOps.pickProjectIcon', {
      projectId
    })
  },
  removeProjectIcon: async (projectId: string): Promise<RemoveProjectIconResult> =>
    getRendererRpcClient().request<RemoveProjectIconResult>('projectOps.removeProjectIcon', {
      projectId
    }),
  initRepository: async (path: string): Promise<InitRepositoryResult> =>
    getRendererRpcClient().request<InitRepositoryResult>('projectOps.initRepository', { path }),
  detectFavicon: async (projectPath: string): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('projectOps.detectFavicon', { path: projectPath })
}
