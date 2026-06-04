import { SETTINGS_UPDATED_CHANNEL } from '@shared/settings-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { DetectedApp } from '@shared/types/settings'
import { getRendererRpcClient } from './rpc-client'

type SettingsOperationResult = {
  success: boolean
  error?: string
}

export type CustomCommandsFileResult = {
  success: boolean
  commands?: Array<{ id: string; name: string; prompt: string }>
  error?: string
  mtime?: number | null
}

export type ReloadCustomCommandsResult = {
  success: boolean
  count?: number
  mtime?: number | null
  error?: string
}

export type SaveCustomCommandsFileResult = {
  success: boolean
  mtime?: number | null
  error?: string
}

export const settingsApi = {
  detectEditors: async (): Promise<DetectedApp[]> =>
    getRendererRpcClient().request<DetectedApp[]>('settingsOps.detectEditors', {}),
  detectTerminals: async (): Promise<DetectedApp[]> =>
    getRendererRpcClient().request<DetectedApp[]>('settingsOps.detectTerminals', {}),
  getAll: async (): Promise<Record<string, string>> =>
    getRendererRpcClient().request<Record<string, string>>('settingsOps.getAll', {}),
  getCustomCommandsFilePath: async (): Promise<string> =>
    getRendererRpcClient().request<string>('settingsOps.getCustomCommandsFilePath', {}),
  loadCustomCommandsFile: async (): Promise<CustomCommandsFileResult> =>
    getRendererRpcClient().request<CustomCommandsFileResult>(
      'settingsOps.loadCustomCommandsFile',
      {}
    ),
  saveCustomCommandsFile: async (
    commands: Array<{ id: string; name: string; prompt: string }>
  ): Promise<SaveCustomCommandsFileResult> =>
    getRendererRpcClient().request<SaveCustomCommandsFileResult>(
      'settingsOps.saveCustomCommandsFile',
      { commands }
    ),
  reloadCustomCommands: async (): Promise<ReloadCustomCommandsResult> =>
    getRendererRpcClient().request<ReloadCustomCommandsResult>(
      'settingsOps.reloadCustomCommands',
      {}
    ),
  openWithEditor: async (
    worktreePath: string,
    editorId: string,
    customCommand?: string
  ): Promise<SettingsOperationResult> =>
    getRendererRpcClient().request<SettingsOperationResult>('settingsOps.openWithEditor', {
      worktreePath,
      editorId,
      ...(customCommand === undefined ? {} : { customCommand })
    }),
  openWithTerminal: async (
    worktreePath: string,
    terminalId: string,
    customCommand?: string
  ): Promise<SettingsOperationResult> =>
    getRendererRpcClient().request<SettingsOperationResult>('settingsOps.openWithTerminal', {
      worktreePath,
      terminalId,
      ...(customCommand === undefined ? {} : { customCommand })
    }),
  onSettingsUpdated: (callback: (data: unknown) => void): (() => void) =>
    getRendererRpcClient().subscribe(SETTINGS_UPDATED_CHANNEL, (event: ServerEvent) => {
      callback(event.payload)
    })
}
