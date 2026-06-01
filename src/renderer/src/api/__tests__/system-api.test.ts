import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_FOCUSED_CHANNEL } from '@shared/app-events'
import { EDIT_PASTE_CHANNEL } from '@shared/edit-events'
import type { MenuActionChannel } from '@shared/menu-events'
import { NOTIFICATION_NAVIGATE_CHANNEL } from '@shared/notification-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import {
  CLOSE_SESSION_SHORTCUT_CHANNEL,
  FILE_SEARCH_SHORTCUT_CHANNEL,
  NEW_SESSION_SHORTCUT_CHANNEL,
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '@shared/shortcut-events'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { systemApi } from '../system-api'

describe('systemApi', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopBridge')
    resetRendererRpcClientForTests()
  })

  it('routes isPackaged through the renderer RPC client', async () => {
    const isPackaged = vi.fn().mockResolvedValue(true)
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        isPackaged
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.isPackaged()).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('systemOps.isPackaged', {})
    expect(isPackaged).not.toHaveBeenCalled()
  })

  it('routes isLogMode through the renderer RPC client', async () => {
    const isLogMode = vi.fn().mockResolvedValue(true)
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        isLogMode
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.isLogMode()).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('systemOps.isLogMode', {})
    expect(isLogMode).not.toHaveBeenCalled()
  })

  it('routes getPlatform through the renderer RPC client', async () => {
    const getPlatform = vi.fn().mockResolvedValue('darwin')
    const request = vi.fn().mockResolvedValue('darwin')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        getPlatform
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.getPlatform()).resolves.toBe('darwin')
    expect(request).toHaveBeenCalledWith('systemOps.getPlatform', {})
    expect(getPlatform).not.toHaveBeenCalled()
  })

  it('routes getLogDir through the renderer RPC client', async () => {
    const getLogDir = vi.fn().mockResolvedValue('/tmp/hive-logs')
    const request = vi.fn().mockResolvedValue('/tmp/hive-logs')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        getLogDir
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.getLogDir()).resolves.toBe('/tmp/hive-logs')
    expect(request).toHaveBeenCalledWith('systemOps.getLogDir', {})
    expect(getLogDir).not.toHaveBeenCalled()
  })

  it('routes getAppVersion through the renderer RPC client', async () => {
    const getAppVersion = vi.fn().mockResolvedValue('1.2.3')
    const request = vi.fn().mockResolvedValue('1.2.3')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        getAppVersion
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.getAppVersion()).resolves.toBe('1.2.3')
    expect(request).toHaveBeenCalledWith('systemOps.getAppVersion', {})
    expect(getAppVersion).not.toHaveBeenCalled()
  })

  it('routes getAppPaths through the renderer RPC client', async () => {
    const appPaths = {
      userData: '/tmp/hive-user-data',
      home: '/home/test',
      logs: '/tmp/hive-logs'
    }
    const getAppPaths = vi.fn().mockResolvedValue(appPaths)
    const request = vi.fn().mockResolvedValue(appPaths)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        getAppPaths
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.getAppPaths()).resolves.toEqual(appPaths)
    expect(request).toHaveBeenCalledWith('systemOps.getAppPaths', {})
    expect(getAppPaths).not.toHaveBeenCalled()
  })

  it('falls back to the renderer RPC client for getAppPaths without desktopBridge support', async () => {
    const appPaths = {
      userData: '/tmp/hive-user-data',
      home: '/home/test',
      logs: '/tmp/hive-logs'
    }
    const request = vi.fn().mockResolvedValue(appPaths)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.getAppPaths()).resolves.toEqual(appPaths)
    expect(request).toHaveBeenCalledWith('systemOps.getAppPaths', {})
  })

  it('routes quitApp through the renderer RPC client', async () => {
    const quitApp = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        quitApp
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.quitApp()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.quitApp', {})
    expect(quitApp).not.toHaveBeenCalled()
  })

  it('falls back to the renderer RPC client for quitApp without desktopBridge support', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.quitApp()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.quitApp', {})
  })

  it('routes setKeepAwake through the renderer RPC client', async () => {
    const setKeepAwake = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        setKeepAwake
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.setKeepAwake(true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.setKeepAwake', { active: true })
    expect(setKeepAwake).not.toHaveBeenCalled()
  })

  it('falls back to the renderer RPC client for setKeepAwake without desktopBridge support', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.setKeepAwake(true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.setKeepAwake', { active: true })
  })

  it('routes sleepNow through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.sleepNow()).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('systemOps.sleepNow', {})
  })

  it('routes setSessionQueuedState through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.setSessionQueuedState('session-1', true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.setSessionQueuedState', {
      sessionId: 'session-1',
      hasQueued: true
    })
  })

  it('routes detectAgentSdks through the renderer RPC client', async () => {
    const detected = { opencode: true, claude: false, codex: true }
    const detectAgentSdks = vi.fn().mockResolvedValue(detected)
    const request = vi.fn().mockResolvedValue(detected)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        detectAgentSdks
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.detectAgentSdks()).resolves.toBe(detected)
    expect(request).toHaveBeenCalledWith('systemOps.detectAgentSdks', {})
    expect(detectAgentSdks).not.toHaveBeenCalled()
  })

  it('falls back to the renderer RPC client for detectAgentSdks without desktopBridge support', async () => {
    const detected = { opencode: true, claude: false, codex: true }
    const request = vi.fn().mockResolvedValue(detected)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.detectAgentSdks()).resolves.toBe(detected)
    expect(request).toHaveBeenCalledWith('systemOps.detectAgentSdks', {})
  })

  it('routes updateMenuState through the renderer RPC client', async () => {
    const updateMenuState = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const state = {
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: false,
      canRedo: true
    }

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        updateMenuState
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.updateMenuState(state)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.updateMenuState', state)
    expect(updateMenuState).not.toHaveBeenCalled()
  })

  it('falls back to the renderer RPC client for updateMenuState without desktopBridge support', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const state = {
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: false,
      canRedo: true
    }

    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.updateMenuState(state)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('systemOps.updateMenuState', state)
  })

  it('routes confirm through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.confirm('Discard changes?')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('systemOps.confirm', { message: 'Discard changes?' })
  })

  it('routes notification navigation through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onNotificationNavigate = vi.fn(
      (_listener: (data: { projectId: string; worktreeId: string; sessionId: string }) => void) =>
        unsubscribe
    )
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onNotificationNavigate
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onNotificationNavigate(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(NOTIFICATION_NAVIGATE_CHANNEL, expect.any(Function))
    expect(onNotificationNavigate).not.toHaveBeenCalled()

    const listener = subscribe.mock.calls[0][1]
    listener({
      channel: NOTIFICATION_NAVIGATE_CHANNEL,
      payload: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        sessionId: 'session-1'
      }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
  })

  it('falls back to the renderer subscription client for notification navigation', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onNotificationNavigate(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(NOTIFICATION_NAVIGATE_CHANNEL, expect.any(Function))
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: NOTIFICATION_NAVIGATE_CHANNEL,
      payload: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        sessionId: 'session-1'
      }
    })
    listener({
      channel: NOTIFICATION_NAVIGATE_CHANNEL,
      payload: {
        projectId: 'project-2',
        worktreeId: 'worktree-2'
      }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
  })

  it('routes window focus through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onWindowFocused = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onWindowFocused
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onWindowFocused(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(WINDOW_FOCUSED_CHANNEL, expect.any(Function))
    expect(onWindowFocused).not.toHaveBeenCalled()

    const listener = subscribe.mock.calls[0][1]
    listener({
      channel: WINDOW_FOCUSED_CHANNEL,
      payload: undefined
    })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('falls back to the renderer subscription client for window focus', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onWindowFocused(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(WINDOW_FOCUSED_CHANNEL, expect.any(Function))
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: WINDOW_FOCUSED_CHANNEL,
      payload: undefined
    })
    listener({
      channel: WINDOW_FOCUSED_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes new-session shortcut through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onNewSessionShortcut = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onNewSessionShortcut
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onNewSessionShortcut(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL, expect.any(Function))
    expect(onNewSessionShortcut).not.toHaveBeenCalled()
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: NEW_SESSION_SHORTCUT_CHANNEL,
      payload: undefined
    })
    listener({
      channel: NEW_SESSION_SHORTCUT_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes file-search shortcut through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onFileSearchShortcut = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onFileSearchShortcut
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onFileSearchShortcut(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(FILE_SEARCH_SHORTCUT_CHANNEL, expect.any(Function))
    expect(onFileSearchShortcut).not.toHaveBeenCalled()
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: FILE_SEARCH_SHORTCUT_CHANNEL,
      payload: undefined
    })
    listener({
      channel: FILE_SEARCH_SHORTCUT_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes close-session shortcut through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onCloseSessionShortcut = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onCloseSessionShortcut
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onCloseSessionShortcut(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(CLOSE_SESSION_SHORTCUT_CHANNEL, expect.any(Function))
    expect(onCloseSessionShortcut).not.toHaveBeenCalled()
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: CLOSE_SESSION_SHORTCUT_CHANNEL,
      payload: undefined
    })
    listener({
      channel: CLOSE_SESSION_SHORTCUT_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes quit-confirmation show through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onQuitConfirmationShow = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onQuitConfirmationShow
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onQuitConfirmationShow(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(QUIT_CONFIRMATION_SHOW_CHANNEL, expect.any(Function))
    expect(onQuitConfirmationShow).not.toHaveBeenCalled()

    const listener = subscribe.mock.calls[0][1]
    listener({
      channel: QUIT_CONFIRMATION_SHOW_CHANNEL,
      payload: undefined
    })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('falls back to the renderer subscription client for quit-confirmation show', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onQuitConfirmationShow(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(QUIT_CONFIRMATION_SHOW_CHANNEL, expect.any(Function))
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: QUIT_CONFIRMATION_SHOW_CHANNEL,
      payload: undefined
    })
    listener({
      channel: QUIT_CONFIRMATION_SHOW_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes quit-confirmation hide through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onQuitConfirmationHide = vi.fn((_listener: () => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onQuitConfirmationHide
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onQuitConfirmationHide(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(QUIT_CONFIRMATION_HIDE_CHANNEL, expect.any(Function))
    expect(onQuitConfirmationHide).not.toHaveBeenCalled()

    const listener = subscribe.mock.calls[0][1]
    listener({
      channel: QUIT_CONFIRMATION_HIDE_CHANNEL,
      payload: undefined
    })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('falls back to the renderer subscription client for quit-confirmation hide', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onQuitConfirmationHide(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(QUIT_CONFIRMATION_HIDE_CHANNEL, expect.any(Function))
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: QUIT_CONFIRMATION_HIDE_CHANNEL,
      payload: undefined
    })
    listener({
      channel: QUIT_CONFIRMATION_HIDE_CHANNEL,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes edit paste through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onEditPaste = vi.fn((_listener: (text: string) => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onEditPaste
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onEditPaste(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(EDIT_PASTE_CHANNEL, expect.any(Function))
    expect(onEditPaste).not.toHaveBeenCalled()

    const listener = subscribe.mock.calls[0][1]
    listener({
      channel: EDIT_PASTE_CHANNEL,
      payload: 'clipboard text'
    })
    listener({
      channel: EDIT_PASTE_CHANNEL,
      payload: { text: 'invalid shape' }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('clipboard text')
  })

  it('falls back to the renderer subscription client for edit paste', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onEditPaste(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(EDIT_PASTE_CHANNEL, expect.any(Function))
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel: EDIT_PASTE_CHANNEL,
      payload: 'clipboard text'
    })
    listener({
      channel: EDIT_PASTE_CHANNEL,
      payload: { text: 'invalid shape' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('clipboard text')
  })

  it('routes menu actions through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onMenuAction = vi.fn((_listener: (action: string) => void) => unsubscribe)
    const subscribe = vi.fn((_channel: string, _callback: (event: ServerEvent) => void) => {
      return unsubscribe
    })
    const callback = vi.fn()
    const channel: MenuActionChannel = 'menu:new-worktree'

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onMenuAction
      }
    })
    setRendererRpcClient({ request, subscribe })

    expect(systemApi.onMenuAction(channel, callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(channel, expect.any(Function))
    expect(onMenuAction).not.toHaveBeenCalled()
    const listener = subscribe.mock.calls[0][1]

    listener({
      channel,
      payload: undefined
    })
    listener({
      channel,
      payload: { ignored: true }
    })

    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('routes openInApp through the renderer RPC client', async () => {
    const result = { success: true }
    const openInApp = vi.fn().mockResolvedValue(result)
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        openInApp
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.openInApp('cursor', '/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('systemOps.openInApp', {
      appName: 'cursor',
      path: '/tmp/hive'
    })
    expect(openInApp).not.toHaveBeenCalled()
  })

  it('routes openInChrome without custom command through the renderer RPC client', async () => {
    const result = { success: true }
    const openExternal = vi.fn().mockResolvedValue(true)
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        openExternal
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(systemApi.openInChrome('https://example.com/pr/1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('systemOps.openInChrome', {
      url: 'https://example.com/pr/1',
      customCommand: undefined
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('routes openInChrome with custom command through the renderer RPC client', async () => {
    const result = { success: true }
    const openInChrome = vi.fn().mockResolvedValue(result)
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        openInChrome
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(
      systemApi.openInChrome('https://example.com/pr/1', 'google-chrome {url}')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('systemOps.openInChrome', {
      url: 'https://example.com/pr/1',
      customCommand: 'google-chrome {url}'
    })
    expect(openInChrome).not.toHaveBeenCalled()
  })

  it('rejects when the renderer RPC client has not been initialized', async () => {
    await expect(systemApi.isPackaged()).rejects.toThrow(
      'Renderer RPC client has not been initialized'
    )
  })
})
