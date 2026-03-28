import { graphqlQuery } from '../client'
import { noopSubscription, notAvailableInWeb } from '../../stubs/electron-only'
import type { SettingsOpsApi } from '../../types'

export function createSettingsOpsAdapter(): SettingsOpsApi {
  return {
    // ─── Working via GraphQL ────────────────────────────────────
    async detectEditors(): Promise<DetectedApp[]> {
      const data = await graphqlQuery<{
        detectedEditors: DetectedApp[]
      }>(
        `query { detectedEditors { id name command available } }`
      )
      return data.detectedEditors
    },

    async detectTerminals(): Promise<DetectedApp[]> {
      const data = await graphqlQuery<{
        detectedTerminals: DetectedApp[]
      }>(
        `query { detectedTerminals { id name command available } }`
      )
      return data.detectedTerminals
    },

    // ─── Stubs ──────────────────────────────────────────────────
    openWithEditor: notAvailableInWeb('settingsOps.openWithEditor') as unknown as (
      worktreePath: string,
      editorId: string,
      customCommand?: string
    ) => Promise<{ success: boolean; error?: string }>,

    openWithTerminal: notAvailableInWeb('settingsOps.openWithTerminal') as unknown as (
      worktreePath: string,
      terminalId: string,
      customCommand?: string
    ) => Promise<{ success: boolean; error?: string }>,

    onSettingsUpdated: (_callback: (data: unknown) => void) => noopSubscription()
  }
}
