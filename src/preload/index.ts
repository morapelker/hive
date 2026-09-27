import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { decodeLocalEnvironmentBootstrapArg } from '../shared/desktop-bridge'

const onMainEvent = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// Voice dictation is desktop-only (microphone, floating pill, paste into the
// focused element), so it talks to the main process over Electron IPC rather
// than the backend RPC. `voice` serves the main window; `voiceHud` the pill.
const voice = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('voice:get-status'),
  updateSettings: (settings: unknown): Promise<void> =>
    ipcRenderer.invoke('voice:update-settings', settings),
  toggle: (): Promise<void> => ipcRenderer.invoke('voice:toggle'),
  cancel: (): Promise<void> => ipcRenderer.invoke('voice:cancel'),
  downloadModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('voice:model:download', modelId),
  cancelDownload: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('voice:model:cancel-download', modelId),
  deleteModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('voice:model:delete', modelId),
  requestMicrophoneAccess: (): Promise<string> => ipcRenderer.invoke('voice:mic:request'),
  openMicrophoneSettings: (): Promise<void> => ipcRenderer.invoke('voice:mic:open-settings'),
  listHistory: (options: { limit: number; offset?: number; query?: string }): Promise<unknown> =>
    ipcRenderer.invoke('voice:history:list', options),
  countHistory: (query?: string): Promise<number> =>
    ipcRenderer.invoke('voice:history:count', query ?? ''),
  deleteHistory: (id: string): Promise<boolean> => ipcRenderer.invoke('voice:history:delete', id),
  clearHistory: (): Promise<number> => ipcRenderer.invoke('voice:history:clear'),
  onStatus: (callback: (status: unknown) => void): (() => void) =>
    onMainEvent('voice:status', callback),
  onResult: (callback: (result: unknown) => void): (() => void) =>
    onMainEvent('voice:result', callback)
}

const voiceHud = {
  ready: (): void => ipcRenderer.send('voice:hud:ready'),
  clickStop: (): void => ipcRenderer.send('voice:hud:click-stop'),
  clickCancel: (): void => ipcRenderer.send('voice:hud:click-cancel'),
  captureStarted: (): void => ipcRenderer.send('voice:hud:capture-started'),
  captureError: (message: string): void => ipcRenderer.send('voice:hud:capture-error', message),
  submitAudio: (payload: {
    samples: Float32Array
    sampleRate: number
    durationMs: number
  }): Promise<void> => ipcRenderer.invoke('voice:hud:audio', payload),
  getSounds: (): Promise<unknown> => ipcRenderer.invoke('voice:hud:get-sounds'),
  onState: (callback: (state: unknown) => void): (() => void) =>
    onMainEvent('voice:hud:state', callback),
  onSound: (callback: (name: string) => void): (() => void) =>
    onMainEvent('voice:hud:sound', callback),
  onCaptureStart: (callback: () => void): (() => void) =>
    onMainEvent('voice:hud:capture-start', callback),
  onCaptureStop: (callback: () => void): (() => void) =>
    onMainEvent('voice:hud:capture-stop', callback),
  onCaptureCancel: (callback: () => void): (() => void) =>
    onMainEvent('voice:hud:capture-cancel', callback)
}

const desktopBridge = {
  voice,
  voiceHud,
  getLocalEnvironmentBootstrap: async () => decodeLocalEnvironmentBootstrapArg(process.argv),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  startHiveEnterpriseLogin: (serverUrl: string): Promise<{ token: string }> =>
    ipcRenderer.invoke('hive-enterprise:start-login', { serverUrl }),
  windowMinimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  windowClose: (): Promise<void> => ipcRenderer.invoke('window:close'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  setTitleBarOverlay: (options: {
    color: string
    symbolColor: string
  }): Promise<void> => ipcRenderer.invoke('window:setTitleBarOverlay', options),
  onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void => {
      callback(isMaximized)
    }
    ipcRenderer.on('window:maximized-changed', listener)
    return () => {
      ipcRenderer.removeListener('window:maximized-changed', listener)
    }
  }
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
