import { graphqlQuery } from '../client'
import { noopSubscription } from '../../stubs/electron-only'
import type { SystemOpsApi } from '../../types'

const isMac = navigator.userAgent.includes('Mac')

export function createSystemOpsAdapter(): SystemOpsApi {
  return {
    // ─── Working via GraphQL ────────────────────────────────────
    async getLogDir(): Promise<string> {
      const data = await graphqlQuery<{ systemLogDir: string }>(
        `query { systemLogDir }`
      )
      return data.systemLogDir
    },

    async getAppVersion(): Promise<string> {
      const data = await graphqlQuery<{ systemAppVersion: string }>(
        `query { systemAppVersion }`
      )
      return data.systemAppVersion
    },

    async getAppPaths(): Promise<{ userData: string; home: string; logs: string }> {
      const data = await graphqlQuery<{
        systemAppPaths: { userData: string; home: string; logs: string }
      }>(
        `query { systemAppPaths { userData home logs } }`
      )
      return data.systemAppPaths
    },

    async detectAgentSdks(): Promise<{ opencode: boolean; claude: boolean; codex: boolean }> {
      const data = await graphqlQuery<{
        systemDetectAgentSdks: { opencode: boolean; claude: boolean; codex: boolean }
      }>(
        `query { systemDetectAgentSdks { opencode claude codex } }`
      )
      return data.systemDetectAgentSdks
    },

    async getPlatform(): Promise<string> {
      if (navigator.userAgent.includes('Mac')) return 'darwin'
      if (navigator.userAgent.includes('Win')) return 'win32'
      if (navigator.userAgent.includes('Linux')) return 'linux'
      return 'web'
    },

    // ─── Browser alternatives ───────────────────────────────────
    onNewSessionShortcut(callback: () => void): () => void {
      const handler = (e: KeyboardEvent): void => {
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 't') {
          e.preventDefault()
          callback()
        }
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    },

    onCloseSessionShortcut(callback: () => void): () => void {
      const handler = (e: KeyboardEvent): void => {
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'w') {
          e.preventDefault()
          callback()
        }
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    },

    onFileSearchShortcut(callback: () => void): () => void {
      const handler = (e: KeyboardEvent): void => {
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'd') {
          e.preventDefault()
          callback()
        }
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    },

    onWindowFocused(callback: () => void): () => void {
      const visibilityHandler = (): void => {
        if (document.visibilityState === 'visible') callback()
      }
      window.addEventListener('focus', callback)
      document.addEventListener('visibilitychange', visibilityHandler)
      return () => {
        window.removeEventListener('focus', callback)
        document.removeEventListener('visibilitychange', visibilityHandler)
      }
    },

    onEditPaste: (_callback: (text: string) => void) => noopSubscription(),

    onNotificationNavigate: (
      _callback: (data: { projectId: string; worktreeId: string; sessionId: string }) => void
    ) => noopSubscription(),

    onMenuAction: (_channel: string, _callback: () => void) => noopSubscription(),

    async openInChrome(
      url: string,
      _customCommand?: string
    ): Promise<{ success: boolean; error?: string }> {
      window.open(url, '_blank')
      return { success: true }
    },

    async openInApp(
      _appName: string,
      path: string
    ): Promise<{ success: boolean; error?: string }> {
      // For URLs, open in new tab; otherwise stub
      if (path.startsWith('http://') || path.startsWith('https://')) {
        window.open(path, '_blank')
        return { success: true }
      }
      return { success: false, error: 'openInApp is not available in web mode' }
    },

    async isPackaged(): Promise<boolean> {
      return false
    },

    async isLogMode(): Promise<boolean> {
      return false
    },

    // ─── Stubs ──────────────────────────────────────────────────
    async quitApp(): Promise<void> {
      // no-op in web mode
    },

    async updateMenuState(
      _state: {
        hasActiveSession: boolean
        hasActiveWorktree: boolean
        canUndo?: boolean
        canRedo?: boolean
      }
    ): Promise<void> {
      // no-op in web mode
    },

    async installServerToPath(): Promise<{ success: boolean; path?: string; error?: string }> {
      return { success: false, error: 'installServerToPath is not available in web mode' }
    },

    async uninstallServerFromPath(): Promise<{ success: boolean; error?: string }> {
      return { success: false, error: 'uninstallServerFromPath is not available in web mode' }
    }
  }
}
