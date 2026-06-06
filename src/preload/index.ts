import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { decodeLocalEnvironmentBootstrapArg } from '../shared/desktop-bridge'

const desktopBridge = {
  getLocalEnvironmentBootstrap: async () => decodeLocalEnvironmentBootstrapArg(process.argv),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  startHiveEnterpriseLogin: (serverUrl: string): Promise<{ token: string }> =>
    ipcRenderer.invoke('hive-enterprise:start-login', { serverUrl })
}

// Force 100% zoom — Ghostty's native NSView overlay requires 1:1 CSS-to-AppKit
// point mapping. Any zoom level breaks coordinate sync and causes misaligned
// rendering. This also resets zoom for users who accidentally changed it.
webFrame.setZoomFactor(1)
webFrame.setVisualZoomLevelLimits(1, 1)

// File tree node type
export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// Flat file entry for search index (no tree structure)
export interface FlatFile {
  name: string
  path: string
  relativePath: string
  extension: string | null
}

// File tree change event types (batched)
export type FileEventType = 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'

export interface FileTreeChangeEventItem {
  eventType: FileEventType
  changedPath: string
  relativePath: string
}

export interface FileTreeChangeEvent {
  worktreePath: string
  events: FileTreeChangeEventItem[]
}

// Git status types
export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

export interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

export interface GitStatusChangedEvent {
  worktreePath: string
}

export interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

// Settings operations API
export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.desktopBridge = desktopBridge
}
