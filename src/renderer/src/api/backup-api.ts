import type {
  BackupExportResult,
  BackupOpenResult,
  BackupProject,
  ProjectClassification,
  RestoreProjectResult
} from '@shared/types/backup'
import { getRendererRpcClient } from './rpc-client'

export type { BackupExportResult, BackupOpenResult }

export const backupApi = {
  exportBackup: async (): Promise<BackupExportResult> =>
    getRendererRpcClient().request<BackupExportResult>('backupOps.exportBackup', {}),

  openBackupFile: async (): Promise<BackupOpenResult> =>
    getRendererRpcClient().request<BackupOpenResult>('backupOps.openBackupFile', {}),

  classifyProjects: async (
    projects: { name: string; path: string; remoteUrl: string | null }[]
  ): Promise<ProjectClassification[]> =>
    getRendererRpcClient().request<ProjectClassification[]>('backupOps.classifyProjects', {
      projects
    }),

  restoreProject: async (
    project: BackupProject,
    options: { cloneParentDir: string | null }
  ): Promise<RestoreProjectResult> =>
    getRendererRpcClient().request<RestoreProjectResult>('backupOps.restoreProject', {
      project,
      options
    })
}
