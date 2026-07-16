import { WINDOW_FOCUSED_CHANNEL } from '@shared/app-events'
import { EDIT_PASTE_CHANNEL } from '@shared/edit-events'
import type { MenuActionChannel } from '@shared/menu-events'
import {
  NOTIFICATION_NAVIGATE_CHANNEL,
  type NotificationNavigatePayload
} from '@shared/notification-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { SystemAppPaths } from '@shared/system-types'
import {
  CLOSE_SESSION_SHORTCUT_CHANNEL,
  FILE_SEARCH_SHORTCUT_CHANNEL,
  NEW_SESSION_SHORTCUT_CHANNEL,
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '@shared/shortcut-events'
import { getRendererRpcClient } from './rpc-client'

interface OpenInChromeResult {
  readonly success: boolean
  readonly error?: string
}

interface OpenInAppResult {
  readonly success: boolean
  readonly error?: string
}

interface AgentSdkDetectionResult {
  readonly opencode: boolean
  readonly claude: boolean
  readonly codex: boolean
  readonly grok: boolean
}

interface MenuStatePayload {
  readonly hasActiveSession: boolean
  readonly hasActiveWorktree: boolean
  readonly canUndo?: boolean
  readonly canRedo?: boolean
}

export const systemApi = {
  isPackaged: async (): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('systemOps.isPackaged', {})
  },
  isLogMode: async (): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('systemOps.isLogMode', {})
  },
  getPlatform: async (): Promise<string> => {
    return getRendererRpcClient().request<string>('systemOps.getPlatform', {})
  },
  getLogDir: async (): Promise<string> => {
    return getRendererRpcClient().request<string>('systemOps.getLogDir', {})
  },
  getAppVersion: async (): Promise<string> => {
    return getRendererRpcClient().request<string>('systemOps.getAppVersion', {})
  },
  getAppPaths: async (): Promise<SystemAppPaths> => {
    return getRendererRpcClient().request<SystemAppPaths>('systemOps.getAppPaths', {})
  },
  quitApp: async (): Promise<void> => {
    return getRendererRpcClient().request<void>('systemOps.quitApp', {})
  },
  setKeepAwake: async (active: boolean): Promise<void> => {
    return getRendererRpcClient().request<void>('systemOps.setKeepAwake', { active })
  },
  sleepNow: async (): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('systemOps.sleepNow', {})
  },
  setSessionQueuedState: async (sessionId: string, hasQueued: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('systemOps.setSessionQueuedState', {
      sessionId,
      hasQueued
    }),
  detectAgentSdks: async (): Promise<AgentSdkDetectionResult> => {
    return getRendererRpcClient().request<AgentSdkDetectionResult>('systemOps.detectAgentSdks', {})
  },
  updateMenuState: async (state: MenuStatePayload): Promise<void> => {
    return getRendererRpcClient().request<void>('systemOps.updateMenuState', state)
  },
  confirm: async (message: string): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('systemOps.confirm', { message })
  },
  onNotificationNavigate: (callback: (data: NotificationNavigatePayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(NOTIFICATION_NAVIGATE_CHANNEL, (event: ServerEvent) => {
      const payload = event.payload
      if (
        payload &&
        typeof payload === 'object' &&
        'projectId' in payload &&
        typeof payload.projectId === 'string' &&
        'worktreeId' in payload &&
        typeof payload.worktreeId === 'string' &&
        'sessionId' in payload &&
        typeof payload.sessionId === 'string'
      ) {
        callback({
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          sessionId: payload.sessionId
        })
      }
    })
  },
  onWindowFocused: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(WINDOW_FOCUSED_CHANNEL, () => {
      callback()
    })
  },
  onNewSessionShortcut: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(NEW_SESSION_SHORTCUT_CHANNEL, () => {
      callback()
    })
  },
  onFileSearchShortcut: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(FILE_SEARCH_SHORTCUT_CHANNEL, () => {
      callback()
    })
  },
  onCloseSessionShortcut: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(CLOSE_SESSION_SHORTCUT_CHANNEL, () => {
      callback()
    })
  },
  onQuitConfirmationShow: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(QUIT_CONFIRMATION_SHOW_CHANNEL, () => {
      callback()
    })
  },
  onQuitConfirmationHide: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(QUIT_CONFIRMATION_HIDE_CHANNEL, () => {
      callback()
    })
  },
  onEditPaste: (callback: (text: string) => void): (() => void) => {
    return getRendererRpcClient().subscribe(EDIT_PASTE_CHANNEL, (event: ServerEvent) => {
      if (typeof event.payload === 'string') {
        callback(event.payload)
      }
    })
  },
  onMenuAction: (channel: MenuActionChannel, callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(channel, () => {
      callback()
    })
  },
  openInApp: async (appName: string, path: string): Promise<OpenInAppResult> => {
    return getRendererRpcClient().request<OpenInAppResult>('systemOps.openInApp', { appName, path })
  },
  openInChrome: async (url: string, customCommand?: string): Promise<OpenInChromeResult> => {
    return getRendererRpcClient().request<OpenInChromeResult>('systemOps.openInChrome', {
      url,
      customCommand
    })
  }
}
