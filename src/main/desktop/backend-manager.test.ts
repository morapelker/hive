import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, dialog, shell } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDesktopCommandRequest, makeDesktopCommandResult } from '../../shared/desktop-command'

const menuMocks = vi.hoisted(() => ({
  updateMenuState: vi.fn()
}))

const powerSaveMocks = vi.hoisted(() => ({
  setKeepAwake: vi.fn()
}))

const sleepNowMocks = vi.hoisted(() => ({
  sleepNow: vi.fn()
}))

const notificationMocks = vi.hoisted(() => ({
  setSessionQueuedState: vi.fn()
}))

const updaterMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getVersion: vi.fn(),
  quitAndInstall: vi.fn(),
  setChannel: vi.fn()
}))

const responseLoggerMocks = vi.hoisted(() => ({
  appendResponseLog: vi.fn(),
  createResponseLog: vi.fn()
}))

const attachmentStorageMocks = vi.hoisted(() => ({
  deleteAttachment: vi.fn(),
  saveAttachment: vi.fn()
}))

const projectIconsMocks = vi.hoisted(() => ({
  getProjectIconDataUrl: vi.fn(),
  removeProjectIcon: vi.fn(),
  saveProjectIcon: vi.fn()
}))

const fileTreeHandlerMocks = vi.hoisted(() => ({
  startFileTreeWatcher: vi.fn(),
  stopFileTreeWatcher: vi.fn()
}))

const terminalHandlerMocks = vi.hoisted(() => ({
  createClaudeCliTerminal: vi.fn(),
  destroyNodePtyTerminal: vi.fn()
}))

const settingsHandlerMocks = vi.hoisted(() => ({
  openPathWithEditor: vi.fn(),
  openPathWithTerminal: vi.fn()
}))

const scriptRunnerMocks = vi.hoisted(() => ({
  killProcess: vi.fn()
}))

const ptyServiceMocks = vi.hoisted(() => ({
  has: vi.fn(),
  resize: vi.fn(),
  write: vi.fn()
}))

const ghosttyServiceMocks = vi.hoisted(() => ({
  createSurface: vi.fn(),
  destroySurface: vi.fn(),
  focusDiagnostics: vi.fn(),
  init: vi.fn(),
  isAvailable: vi.fn(),
  isInitialized: vi.fn(),
  keyEvent: vi.fn(),
  loadAddon: vi.fn(),
  mouseButton: vi.fn(),
  mousePos: vi.fn(),
  mouseScroll: vi.fn(),
  pasteText: vi.fn(),
  setFocus: vi.fn(),
  setFrame: vi.fn(),
  setSize: vi.fn(),
  shutdown: vi.fn()
}))

const petWindowMocks = vi.hoisted(() => ({
  beginPetPointerInteraction: vi.fn(),
  createPetWindow: vi.fn(),
  destroyPetWindow: vi.fn(),
  endPetPointerInteraction: vi.fn(),
  focusMainWindowFromPet: vi.fn(),
  forwardStatusToPet: vi.fn(),
  getCurrentPetStatus: vi.fn(),
  getPetConfig: vi.fn(),
  movePetWindow: vi.fn(),
  persistPetSettings: vi.fn(),
  setPetIgnoreMouseEvents: vi.fn(),
  updatePetSettings: vi.fn()
}))

vi.mock('../menu', () => ({
  updateMenuState: menuMocks.updateMenuState
}))

vi.mock('../services/power-save-blocker', () => ({
  setKeepAwake: powerSaveMocks.setKeepAwake
}))

vi.mock('../services/sleep-now', () => ({
  sleepNow: sleepNowMocks.sleepNow
}))

vi.mock('../services/notification-service', () => ({
  notificationService: {
    setSessionQueuedState: notificationMocks.setSessionQueuedState
  }
}))

vi.mock('../services/updater', () => ({
  updaterService: {
    checkForUpdates: updaterMocks.checkForUpdates,
    downloadUpdate: updaterMocks.downloadUpdate,
    getVersion: updaterMocks.getVersion,
    quitAndInstall: updaterMocks.quitAndInstall,
    setChannel: updaterMocks.setChannel
  }
}))

vi.mock('../services/response-logger', () => ({
  appendResponseLog: responseLoggerMocks.appendResponseLog,
  createResponseLog: responseLoggerMocks.createResponseLog
}))

vi.mock('../services/attachment-storage', () => ({
  deleteAttachment: attachmentStorageMocks.deleteAttachment,
  saveAttachment: attachmentStorageMocks.saveAttachment
}))

vi.mock('../services/project-icons', () => ({
  getProjectIconDataUrl: projectIconsMocks.getProjectIconDataUrl,
  removeProjectIcon: projectIconsMocks.removeProjectIcon,
  saveProjectIcon: projectIconsMocks.saveProjectIcon
}))

vi.mock('../services/file-tree-watcher', () => ({
  startFileTreeWatcher: fileTreeHandlerMocks.startFileTreeWatcher,
  stopFileTreeWatcher: fileTreeHandlerMocks.stopFileTreeWatcher
}))

vi.mock('../services/terminal-pty-bridge', () => ({
  createClaudeCliTerminal: terminalHandlerMocks.createClaudeCliTerminal,
  destroyNodePtyTerminal: terminalHandlerMocks.destroyNodePtyTerminal
}))

vi.mock('../services/settings-openers', () => ({
  openPathWithEditor: settingsHandlerMocks.openPathWithEditor,
  openPathWithTerminal: settingsHandlerMocks.openPathWithTerminal
}))

vi.mock('../services/script-runner', () => ({
  scriptRunner: {
    killProcess: scriptRunnerMocks.killProcess
  }
}))

vi.mock('../services/pty-service', () => ({
  ptyService: {
    has: ptyServiceMocks.has,
    resize: ptyServiceMocks.resize,
    write: ptyServiceMocks.write
  }
}))

vi.mock('../services/ghostty-service', () => ({
  ghosttyService: ghosttyServiceMocks
}))

vi.mock('../services/pet-window', () => ({
  beginPetPointerInteraction: petWindowMocks.beginPetPointerInteraction,
  createPetWindow: petWindowMocks.createPetWindow,
  destroyPetWindow: petWindowMocks.destroyPetWindow,
  endPetPointerInteraction: petWindowMocks.endPetPointerInteraction,
  focusMainWindowFromPet: petWindowMocks.focusMainWindowFromPet,
  forwardStatusToPet: petWindowMocks.forwardStatusToPet,
  getCurrentPetStatus: petWindowMocks.getCurrentPetStatus,
  getPetConfig: petWindowMocks.getPetConfig,
  movePetWindow: petWindowMocks.movePetWindow,
  persistPetSettings: petWindowMocks.persistPetSettings,
  setPetIgnoreMouseEvents: petWindowMocks.setPetIgnoreMouseEvents,
  updatePetSettings: petWindowMocks.updatePetSettings
}))

import {
  __resetDesktopBackendForTests,
  getDesktopBackendBootstrap,
  setDesktopBackendOpenCodeAbortHandler,
  setDesktopBackendOpenCodeCapabilitiesHandler,
  setDesktopBackendOpenCodeCommandHandler,
  setDesktopBackendOpenCodeCommandsHandler,
  setDesktopBackendOpenCodeCommandApprovalReplyHandler,
  setDesktopBackendOpenCodeConnectHandler,
  setDesktopBackendOpenCodeDisconnectHandler,
  setDesktopBackendOpenCodeForkHandler,
  setDesktopBackendOpenCodeGetMessagesHandler,
  setDesktopBackendOpenCodeListModelsHandler,
  setDesktopBackendOpenCodeModelInfoHandler,
  setDesktopBackendOpenCodePermissionListHandler,
  setDesktopBackendOpenCodePermissionReplyHandler,
  setDesktopBackendOpenCodePlanApproveHandler,
  setDesktopBackendOpenCodePlanRejectHandler,
  setDesktopBackendOpenCodePromptHandler,
  setDesktopBackendOpenCodeQuestionReplyHandler,
  setDesktopBackendOpenCodeQuestionRejectHandler,
  setDesktopBackendOpenCodeRefreshFromThreadHandler,
  setDesktopBackendOpenCodeRedoHandler,
  setDesktopBackendOpenCodeReconnectHandler,
  setDesktopBackendOpenCodeRenameSessionHandler,
  setDesktopBackendOpenCodeSetModelHandler,
  setDesktopBackendOpenCodeSessionInfoHandler,
  setDesktopBackendOpenCodeSteerHandler,
  setDesktopBackendOpenCodeUndoHandler,
  startDesktopBackend,
  waitForBackendReady
} from './backend-manager'
import { publishDesktopBackendEvent } from './backend-event-publisher'

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    callback?.(null)
    return true
  })

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true
    this.emit('exit', signal === 'SIGKILL' ? null : 0, signal ?? null)
    return true
  })
}

describe('desktop backend manager', () => {
  afterEach(async () => {
    await __resetDesktopBackendForTests()
    menuMocks.updateMenuState.mockClear()
    powerSaveMocks.setKeepAwake.mockClear()
    sleepNowMocks.sleepNow.mockClear()
    notificationMocks.setSessionQueuedState.mockClear()
    updaterMocks.checkForUpdates.mockClear()
    updaterMocks.downloadUpdate.mockClear()
    updaterMocks.getVersion.mockClear()
    updaterMocks.quitAndInstall.mockClear()
    updaterMocks.setChannel.mockClear()
    responseLoggerMocks.appendResponseLog.mockClear()
    responseLoggerMocks.createResponseLog.mockClear()
    attachmentStorageMocks.deleteAttachment.mockClear()
    ptyServiceMocks.has.mockClear()
    ptyServiceMocks.resize.mockClear()
    ptyServiceMocks.write.mockClear()
    attachmentStorageMocks.saveAttachment.mockClear()
    projectIconsMocks.getProjectIconDataUrl.mockClear()
    projectIconsMocks.removeProjectIcon.mockClear()
    projectIconsMocks.saveProjectIcon.mockClear()
    fileTreeHandlerMocks.startFileTreeWatcher.mockClear()
    fileTreeHandlerMocks.stopFileTreeWatcher.mockClear()
    terminalHandlerMocks.createClaudeCliTerminal.mockClear()
    terminalHandlerMocks.destroyNodePtyTerminal.mockClear()
    settingsHandlerMocks.openPathWithEditor.mockClear()
    settingsHandlerMocks.openPathWithTerminal.mockClear()
    scriptRunnerMocks.killProcess.mockClear()
    ghosttyServiceMocks.createSurface.mockClear()
    ghosttyServiceMocks.destroySurface.mockClear()
    ghosttyServiceMocks.focusDiagnostics.mockClear()
    ghosttyServiceMocks.init.mockClear()
    ghosttyServiceMocks.isAvailable.mockClear()
    ghosttyServiceMocks.isInitialized.mockClear()
    ghosttyServiceMocks.keyEvent.mockClear()
    ghosttyServiceMocks.loadAddon.mockClear()
    ghosttyServiceMocks.mouseButton.mockClear()
    ghosttyServiceMocks.mousePos.mockClear()
    ghosttyServiceMocks.mouseScroll.mockClear()
    ghosttyServiceMocks.pasteText.mockClear()
    ghosttyServiceMocks.setFocus.mockClear()
    ghosttyServiceMocks.setFrame.mockClear()
    ghosttyServiceMocks.setSize.mockClear()
    ghosttyServiceMocks.shutdown.mockClear()
    petWindowMocks.beginPetPointerInteraction.mockClear()
    petWindowMocks.createPetWindow.mockClear()
    petWindowMocks.destroyPetWindow.mockClear()
    petWindowMocks.endPetPointerInteraction.mockClear()
    petWindowMocks.focusMainWindowFromPet.mockClear()
    petWindowMocks.forwardStatusToPet.mockClear()
    petWindowMocks.getCurrentPetStatus.mockClear()
    petWindowMocks.getPetConfig.mockClear()
    petWindowMocks.movePetWindow.mockClear()
    petWindowMocks.persistPetSettings.mockClear()
    petWindowMocks.setPetIgnoreMouseEvents.mockClear()
    petWindowMocks.updatePetSettings.mockClear()
    vi.restoreAllMocks()
  })

  it('spawns the backend and waits for readiness before resolving', async () => {
    const child = new FakeChildProcess()
    const spawnProcess = vi.fn(() => child as never)
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const logger = makeLogger()

    const backend = await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      { spawnProcess, fetch: fetchImpl, logger }
    )

    expect(spawnProcess).toHaveBeenCalledWith(
      '/electron',
      ['/app/server.js'],
      expect.objectContaining({
        cwd: '/app',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          HIVE_SERVER_MODE: 'desktop',
          HIVE_DESKTOP_BOOTSTRAP_TOKEN: backend.config.bootstrapToken
        })
      })
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      `${backend.config.httpBaseUrl}/.well-known/hive/environment`
    )
    expect(getDesktopBackendBootstrap()).toEqual(backend.bootstrap)
  })

  it('authenticates before publishing desktop backend events over HTTP', async () => {
    const child = new FakeChildProcess()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { accessToken: 'access-token-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const backend = await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      { spawnProcess: vi.fn(() => child as never), fetch: fetchImpl, logger: makeLogger() }
    )

    await expect(
      publishDesktopBackendEvent(
        'test:channel',
        { message: 'hello' },
        fetchImpl as unknown as typeof fetch
      )
    ).resolves.toBe(true)

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${backend.bootstrap.httpBaseUrl}/api/auth/bootstrap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: backend.bootstrap.bootstrapToken })
      }
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      `${backend.bootstrap.httpBaseUrl}/api/events/publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token-1'
        },
        body: JSON.stringify({ channel: 'test:channel', payload: { message: 'hello' } })
      }
    )
  })

  it('retries readiness checks until the backend responds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('not listening yet'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await waitForBackendReady('http://127.0.0.1:3773', {
      fetchImpl,
      timeoutMs: 500,
      intervalMs: 1
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops the backend child process', async () => {
    const child = new FakeChildProcess()
    const backend = await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    await backend.stop()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('forwards backend quit commands to the Electron app', async () => {
    const child = new FakeChildProcess()
    const quitSpy = vi.spyOn(app, 'quit').mockImplementation(() => undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('quit-1', 'quitApp'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('quit-1', { ok: true }),
      expect.any(Function)
    )
    expect(quitSpy).toHaveBeenCalled()
  })

  it('forwards backend confirm commands to the native dialog implementation', async () => {
    const child = new FakeChildProcess()
    const showMessageBoxSpy = vi
      .spyOn(dialog, 'showMessageBox')
      .mockResolvedValueOnce({ response: 1 } as never)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('confirm-1', 'confirm', { message: 'Discard changes?' })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showMessageBoxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Discard changes?',
        buttons: ['Cancel', 'OK']
      })
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('confirm-1', { ok: true, value: true }),
      expect.any(Function)
    )
    showMessageBoxSpy.mockRestore()
  })

  it('forwards backend projectOpenDirectoryDialog commands to the native folder picker', async () => {
    const child = new FakeChildProcess()
    const showOpenDialogSpy = vi.spyOn(dialog, 'showOpenDialog').mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/hive-project']
    } as never)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-open-directory-dialog-1', 'projectOpenDirectoryDialog')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showOpenDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Select Project Folder',
        buttonLabel: 'Add Project',
        properties: ['openDirectory', 'createDirectory']
      })
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-open-directory-dialog-1', {
        ok: true,
        value: '/tmp/hive-project'
      }),
      expect.any(Function)
    )
    showOpenDialogSpy.mockRestore()
  })

  it('forwards backend projectShowInFolder commands to the native shell implementation', async () => {
    const child = new FakeChildProcess()
    const showItemInFolderSpy = vi.spyOn(shell, 'showItemInFolder').mockImplementation(() => {})

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-show-in-folder-1', 'projectShowInFolder', {
        path: '/tmp/hive/package.json'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showItemInFolderSpy).toHaveBeenCalledWith('/tmp/hive/package.json')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-show-in-folder-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
    showItemInFolderSpy.mockRestore()
  })

  it('forwards backend projectOpenPath commands to the native shell implementation', async () => {
    const child = new FakeChildProcess()
    const openPathSpy = vi.spyOn(shell, 'openPath').mockResolvedValueOnce('')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-open-path-1', 'projectOpenPath', {
        path: '/tmp/hive/package.json'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(openPathSpy).toHaveBeenCalledWith('/tmp/hive/package.json')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-open-path-1', {
        ok: true,
        value: ''
      }),
      expect.any(Function)
    )
    openPathSpy.mockRestore()
  })

  it('forwards backend projectWriteClipboardText commands to the native clipboard implementation', async () => {
    const child = new FakeChildProcess()
    const writeTextSpy = vi.spyOn(clipboard, 'writeText').mockImplementation(() => undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-write-clipboard-text-1', 'projectWriteClipboardText', {
        text: '/tmp/hive/package.json'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(writeTextSpy).toHaveBeenCalledWith('/tmp/hive/package.json')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-write-clipboard-text-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
    writeTextSpy.mockRestore()
  })

  it('forwards backend projectReadClipboardText commands to the native clipboard implementation', async () => {
    const child = new FakeChildProcess()
    const readTextSpy = vi.spyOn(clipboard, 'readText').mockReturnValue('/tmp/hive/package.json')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-read-clipboard-text-1', 'projectReadClipboardText')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(readTextSpy).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-read-clipboard-text-1', {
        ok: true,
        value: '/tmp/hive/package.json'
      }),
      expect.any(Function)
    )
    readTextSpy.mockRestore()
  })

  it('forwards backend projectPickProjectIcon commands to the native icon picker', async () => {
    const child = new FakeChildProcess()
    const showOpenDialogSpy = vi.spyOn(dialog, 'showOpenDialog').mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/hive/icon.png']
    } as never)
    projectIconsMocks.saveProjectIcon.mockReturnValueOnce({
      success: true,
      filename: 'project-1.png'
    })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-pick-project-icon-1', 'projectPickProjectIcon', {
        projectId: 'project-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showOpenDialogSpy).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        properties: ['openFile'],
        title: 'Select Project Icon',
        buttonLabel: 'Select Icon',
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }]
      })
    )
    expect(projectIconsMocks.saveProjectIcon).toHaveBeenCalledWith(
      'project-1',
      '/tmp/hive/icon.png',
      '/tmp/hive-test-mock-home/.hive/project-icons'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-pick-project-icon-1', {
        ok: true,
        value: { success: true, filename: 'project-1.png' }
      }),
      expect.any(Function)
    )
    showOpenDialogSpy.mockRestore()
  })

  it('forwards backend projectRemoveProjectIcon commands to the native icon storage', async () => {
    const child = new FakeChildProcess()
    projectIconsMocks.removeProjectIcon.mockReturnValueOnce({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-remove-project-icon-1', 'projectRemoveProjectIcon', {
        projectId: 'project-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(projectIconsMocks.removeProjectIcon).toHaveBeenCalledWith(
      'project-1',
      '/tmp/hive-test-mock-home/.hive/project-icons'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-remove-project-icon-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend projectGetProjectIconPath commands to the native icon storage', async () => {
    const child = new FakeChildProcess()
    projectIconsMocks.getProjectIconDataUrl.mockReturnValueOnce('data:image/png;base64,icon')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('project-get-project-icon-path-1', 'projectGetProjectIconPath', {
        filename: 'project-1.png'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(projectIconsMocks.getProjectIconDataUrl).toHaveBeenCalledWith(
      'project-1.png',
      '/tmp/hive-test-mock-home/.hive/project-icons'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('project-get-project-icon-path-1', {
        ok: true,
        value: 'data:image/png;base64,icon'
      }),
      expect.any(Function)
    )
  })

  it('forwards backend gitShowInFinder commands to the native shell implementation', async () => {
    const child = new FakeChildProcess()
    const showItemInFolderSpy = vi.spyOn(shell, 'showItemInFolder').mockImplementation(() => {})

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('git-show-in-finder-1', 'gitShowInFinder', {
        filePath: '/tmp/hive/src/App.tsx'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showItemInFolderSpy).toHaveBeenCalledWith('/tmp/hive/src/App.tsx')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('git-show-in-finder-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
    showItemInFolderSpy.mockRestore()
  })

  it('forwards backend kanbanOpenBoardImportFileDialog commands to the native file picker', async () => {
    const child = new FakeChildProcess()
    const showOpenDialogSpy = vi.spyOn(dialog, 'showOpenDialog').mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/hive/board.hive.json']
    } as never)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'kanban-open-board-import-file-dialog-1',
        'kanbanOpenBoardImportFileDialog'
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showOpenDialogSpy).toHaveBeenCalledWith({
      filters: [{ name: 'Hive Board', extensions: ['json'] }],
      properties: ['openFile']
    })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('kanban-open-board-import-file-dialog-1', {
        ok: true,
        value: { filePath: '/tmp/hive/board.hive.json' }
      }),
      expect.any(Function)
    )
    showOpenDialogSpy.mockRestore()
  })

  it('forwards backend kanbanSaveBoardExportDialog commands to the native save picker', async () => {
    const child = new FakeChildProcess()
    const showSaveDialogSpy = vi.spyOn(dialog, 'showSaveDialog').mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/hive/board-Hive.hive.json'
    } as never)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'kanban-save-board-export-dialog-1',
        'kanbanSaveBoardExportDialog',
        {
          projectName: 'Hive'
        }
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(showSaveDialogSpy).toHaveBeenCalledWith({
      defaultPath: 'board-Hive.hive.json',
      filters: [{ name: 'Hive Board', extensions: ['hive.json'] }]
    })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('kanban-save-board-export-dialog-1', {
        ok: true,
        value: { filePath: '/tmp/hive/board-Hive.hive.json' }
      }),
      expect.any(Function)
    )
    showSaveDialogSpy.mockRestore()
  })

  it('forwards backend systemGetAppVersion commands to the native app implementation', async () => {
    const child = new FakeChildProcess()
    const getVersionSpy = vi.spyOn(app, 'getVersion').mockReturnValueOnce('1.2.3')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('system-get-app-version-1', 'systemGetAppVersion')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(getVersionSpy).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('system-get-app-version-1', {
        ok: true,
        value: '1.2.3'
      }),
      expect.any(Function)
    )
    getVersionSpy.mockRestore()
  })

  it('forwards backend systemGetAppPaths commands to the native app implementation', async () => {
    const child = new FakeChildProcess()
    const getPathSpy = vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
      if (name === 'userData') return '/tmp/hive-user-data'
      if (name === 'home') return '/tmp/hive-home'
      return `/tmp/hive-${name}`
    })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('system-get-app-paths-1', 'systemGetAppPaths'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(getPathSpy).toHaveBeenCalledWith('userData')
    expect(getPathSpy).toHaveBeenCalledWith('home')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('system-get-app-paths-1', {
        ok: true,
        value: {
          userData: '/tmp/hive-user-data',
          home: '/tmp/hive-home'
        }
      }),
      expect.any(Function)
    )
    getPathSpy.mockRestore()
  })

  it('forwards backend systemIsPackaged commands to the native app implementation', async () => {
    const child = new FakeChildProcess()
    const originalIsPackaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
    const isPackagedSpy = vi.fn(() => true)
    Object.defineProperty(app, 'isPackaged', {
      configurable: true,
      get: isPackagedSpy
    })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('system-is-packaged-1', 'systemIsPackaged'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(isPackagedSpy).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('system-is-packaged-1', {
        ok: true,
        value: true
      }),
      expect.any(Function)
    )
    if (originalIsPackaged) {
      Object.defineProperty(app, 'isPackaged', originalIsPackaged)
    }
  })

  it('forwards backend openInApp commands to the main-process implementation', async () => {
    const child = new FakeChildProcess()
    const writeTextSpy = vi.spyOn(clipboard, 'writeText').mockImplementation(() => undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('open-in-app-1', 'openInApp', {
        appName: 'copy-path',
        path: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(writeTextSpy).toHaveBeenCalledWith('/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('open-in-app-1', { ok: true, value: { success: true } }),
      expect.any(Function)
    )
  })

  it('forwards backend openInChrome commands to the main-process implementation', async () => {
    const child = new FakeChildProcess()
    const openExternalSpy = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('open-in-chrome-1', 'openInChrome', {
        url: 'https://example.com'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(openExternalSpy).toHaveBeenCalledWith('https://example.com')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('open-in-chrome-1', { ok: true, value: { success: true } }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeConnect commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const connectHandler = vi.fn(async () => ({ success: true, sessionId: 'oc-session-1' }))
    setDesktopBackendOpenCodeConnectHandler(connectHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-connect-1', 'opencodeConnect', {
        worktreePath: '/tmp/hive',
        hiveSessionId: 'hive-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(connectHandler).toHaveBeenCalledWith('/tmp/hive', 'hive-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-connect-1', {
        ok: true,
        value: { success: true, sessionId: 'oc-session-1' }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeReconnect commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const reconnectHandler = vi.fn(async () => ({
      success: true,
      sessionStatus: 'busy' as const,
      revertMessageID: null
    }))
    setDesktopBackendOpenCodeReconnectHandler(reconnectHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-reconnect-1', 'opencodeReconnect', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1',
        hiveSessionId: 'hive-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(reconnectHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1', 'hive-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-reconnect-1', {
        ok: true,
        value: { success: true, sessionStatus: 'busy', revertMessageID: null }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodePrompt commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const promptHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodePromptHandler(promptHandler)
    const model = { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'latest' }
    const options = { codexFastMode: true }

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-prompt-1', 'opencodePrompt', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1',
        messageOrParts: [{ type: 'text', text: 'hello' }],
        model,
        options
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(promptHandler).toHaveBeenCalledWith(
      '/tmp/hive',
      'oc-session-1',
      [{ type: 'text', text: 'hello' }],
      model,
      options
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-prompt-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeAbort commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const abortHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeAbortHandler(abortHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-abort-1', 'opencodeAbort', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(abortHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-abort-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeSteer commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const steerHandler = vi.fn(async () => ({
      success: true,
      insertedMessageId: 'msg-inserted',
      nextAssistantMessageId: 'msg-next',
      turnId: 'turn-1'
    }))
    setDesktopBackendOpenCodeSteerHandler(steerHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-steer-1', 'opencodeSteer', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1',
        message: 'continue'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(steerHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1', 'continue')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-steer-1', {
        ok: true,
        value: {
          success: true,
          insertedMessageId: 'msg-inserted',
          nextAssistantMessageId: 'msg-next',
          turnId: 'turn-1'
        }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeDisconnect commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const disconnectHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeDisconnectHandler(disconnectHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-disconnect-1', 'opencodeDisconnect', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(disconnectHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-disconnect-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeGetMessages commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const getMessagesHandler = vi.fn(async () => ({
      success: true,
      messages: [{ id: 'msg-1' }]
    }))
    setDesktopBackendOpenCodeGetMessagesHandler(getMessagesHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-get-messages-1', 'opencodeGetMessages', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(getMessagesHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-get-messages-1', {
        ok: true,
        value: { success: true, messages: [{ id: 'msg-1' }] }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeRefreshFromThread commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const refreshFromThreadHandler = vi.fn(async () => ({ success: true, count: 2 }))
    setDesktopBackendOpenCodeRefreshFromThreadHandler(refreshFromThreadHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-refresh-from-thread-1', 'opencodeRefreshFromThread', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'oc-session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(refreshFromThreadHandler).toHaveBeenCalledWith('/tmp/hive', 'oc-session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-refresh-from-thread-1', {
        ok: true,
        value: { success: true, count: 2 }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeListModels commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const providers = [{ id: 'codex', models: { 'gpt-5': { id: 'gpt-5' } } }]
    const listModelsHandler = vi.fn(async () => ({ success: true, providers }))
    setDesktopBackendOpenCodeListModelsHandler(listModelsHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-list-models-1', 'opencodeListModels', {
        agentSdk: 'codex'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(listModelsHandler).toHaveBeenCalledWith({ agentSdk: 'codex' })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-list-models-1', {
        ok: true,
        value: { success: true, providers }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeSetModel commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const setModelHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeSetModelHandler(setModelHandler)
    const model = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'high',
      agentSdk: 'codex' as const
    }

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-set-model-1', 'opencodeSetModel', { model })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(setModelHandler).toHaveBeenCalledWith(model)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-set-model-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeModelInfo commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const model = {
      id: 'gpt-5',
      name: 'GPT-5',
      limit: { context: 400000, output: 128000 }
    }
    const modelInfoHandler = vi.fn(async () => ({ success: true, model }))
    setDesktopBackendOpenCodeModelInfoHandler(modelInfoHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-model-info-1', 'opencodeModelInfo', {
        worktreePath: '/tmp/hive',
        modelId: 'gpt-5',
        agentSdk: 'codex'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(modelInfoHandler).toHaveBeenCalledWith('/tmp/hive', 'gpt-5', 'codex')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-model-info-1', {
        ok: true,
        value: { success: true, model }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeQuestionReply commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const questionReplyHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeQuestionReplyHandler(questionReplyHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-question-reply-1', 'opencodeQuestionReply', {
        requestId: 'question-1',
        answers: [['yes']],
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(questionReplyHandler).toHaveBeenCalledWith('question-1', [['yes']], '/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-question-reply-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeQuestionReject commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const questionRejectHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeQuestionRejectHandler(questionRejectHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-question-reject-1', 'opencodeQuestionReject', {
        requestId: 'question-1',
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(questionRejectHandler).toHaveBeenCalledWith('question-1', '/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-question-reject-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodePlanApprove commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const planApproveHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodePlanApproveHandler(planApproveHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-plan-approve-1', 'opencodePlanApprove', {
        worktreePath: '/tmp/hive',
        hiveSessionId: 'hive-session-1',
        requestId: 'plan-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(planApproveHandler).toHaveBeenCalledWith('/tmp/hive', 'hive-session-1', 'plan-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-plan-approve-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodePlanReject commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const planRejectHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodePlanRejectHandler(planRejectHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-plan-reject-1', 'opencodePlanReject', {
        worktreePath: '/tmp/hive',
        hiveSessionId: 'hive-session-1',
        feedback: 'Needs more detail',
        requestId: 'plan-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(planRejectHandler).toHaveBeenCalledWith(
      '/tmp/hive',
      'hive-session-1',
      'Needs more detail',
      'plan-1'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-plan-reject-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodePermissionReply commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const permissionReplyHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodePermissionReplyHandler(permissionReplyHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-permission-reply-1', 'opencodePermissionReply', {
        requestId: 'permission-1',
        reply: 'once',
        worktreePath: '/tmp/hive',
        message: 'Approved for this run'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(permissionReplyHandler).toHaveBeenCalledWith(
      'permission-1',
      'once',
      '/tmp/hive',
      'Approved for this run'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-permission-reply-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodePermissionList commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const permissions = [{ id: 'permission-1' }]
    const permissionListHandler = vi.fn(async () => ({ success: true, permissions }))
    setDesktopBackendOpenCodePermissionListHandler(permissionListHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-permission-list-1', 'opencodePermissionList', {
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(permissionListHandler).toHaveBeenCalledWith('/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-permission-list-1', {
        ok: true,
        value: { success: true, permissions }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeCommandApprovalReply commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const commandApprovalReplyHandler = vi.fn(async () => ({ success: true }))
    setDesktopBackendOpenCodeCommandApprovalReplyHandler(commandApprovalReplyHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'opencode-command-approval-reply-1',
        'opencodeCommandApprovalReply',
        {
          requestId: 'approval-1',
          approved: true,
          remember: 'allow',
          pattern: 'npm test',
          worktreePath: '/tmp/hive',
          patterns: ['npm test', 'pnpm test']
        }
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(commandApprovalReplyHandler).toHaveBeenCalledWith(
      'approval-1',
      true,
      'allow',
      'npm test',
      '/tmp/hive',
      ['npm test', 'pnpm test']
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-command-approval-reply-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeSessionInfo commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = { success: true, revertMessageID: 'msg-2', revertDiff: 'diff --git' }
    const sessionInfoHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeSessionInfoHandler(sessionInfoHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-session-info-1', 'opencodeSessionInfo', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(sessionInfoHandler).toHaveBeenCalledWith('/tmp/hive', 'session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-session-info-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeUndo commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = {
      success: true,
      revertMessageID: 'msg-2',
      restoredPrompt: 'please change it',
      revertDiff: 'diff --git'
    }
    const undoHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeUndoHandler(undoHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-undo-1', 'opencodeUndo', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(undoHandler).toHaveBeenCalledWith('/tmp/hive', 'session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-undo-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeRedo commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = { success: true, revertMessageID: null }
    const redoHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeRedoHandler(redoHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-redo-1', 'opencodeRedo', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(redoHandler).toHaveBeenCalledWith('/tmp/hive', 'session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-redo-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeCommand commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = { success: true }
    const commandHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeCommandHandler(commandHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    const model = { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'opus' }
    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-command-1', 'opencodeCommand', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'session-1',
        command: 'review',
        args: '--fast',
        model
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(commandHandler).toHaveBeenCalledWith(
      '/tmp/hive',
      'session-1',
      'review',
      '--fast',
      model,
      undefined
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-command-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeCommands commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = {
      success: true,
      commands: [{ name: 'review', description: 'Review changes', template: '/review $ARGUMENTS' }]
    }
    const commandsHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeCommandsHandler(commandsHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-commands-1', 'opencodeCommands', {
        worktreePath: '/tmp/hive',
        sessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(commandsHandler).toHaveBeenCalledWith('/tmp/hive', 'session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-commands-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeRenameSession commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = { success: true }
    const renameSessionHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeRenameSessionHandler(renameSessionHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-rename-session-1', 'opencodeRenameSession', {
        opencodeSessionId: 'session-1',
        title: 'New title',
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(renameSessionHandler).toHaveBeenCalledWith('session-1', 'New title', '/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-rename-session-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeCapabilities commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = {
      success: true,
      capabilities: {
        supportsUndo: true,
        supportsRedo: false,
        supportsCommands: true,
        supportsPermissionRequests: true,
        supportsQuestionPrompts: false,
        supportsModelSelection: true,
        supportsReconnect: true,
        supportsPartialStreaming: false,
        supportsSteer: true
      }
    }
    const capabilitiesHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeCapabilitiesHandler(capabilitiesHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-capabilities-1', 'opencodeCapabilities', {
        sessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(capabilitiesHandler).toHaveBeenCalledWith('session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-capabilities-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend opencodeFork commands to the registered main-process handler', async () => {
    const child = new FakeChildProcess()
    const result = { success: true, sessionId: 'forked-session-1' }
    const forkHandler = vi.fn(async () => result)
    setDesktopBackendOpenCodeForkHandler(forkHandler)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('opencode-fork-1', 'opencodeFork', {
        worktreePath: '/tmp/hive',
        opencodeSessionId: 'session-1',
        messageId: 'message-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(forkHandler).toHaveBeenCalledWith('/tmp/hive', 'session-1', 'message-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('opencode-fork-1', {
        ok: true,
        value: result
      }),
      expect.any(Function)
    )
  })

  it('forwards backend updateMenuState commands to the native menu implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    const state = {
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: false,
      canRedo: true
    }

    child.emit('message', makeDesktopCommandRequest('menu-state-1', 'updateMenuState', state))
    await new Promise((resolve) => setImmediate(resolve))

    expect(menuMocks.updateMenuState).toHaveBeenCalledWith(state)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('menu-state-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend setKeepAwake commands to the power-save blocker implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('keep-awake-1', 'setKeepAwake', { active: true })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(powerSaveMocks.setKeepAwake).toHaveBeenCalledWith(true)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('keep-awake-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend sleepNow commands to the native sleep implementation', async () => {
    const child = new FakeChildProcess()
    sleepNowMocks.sleepNow.mockReturnValue(true)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('sleep-now-1', 'sleepNow'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(sleepNowMocks.sleepNow).toHaveBeenCalledWith()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('sleep-now-1', { ok: true, value: true }),
      expect.any(Function)
    )
  })

  it('forwards backend setSessionQueuedState commands to the notification service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('queued-state-1', 'setSessionQueuedState', {
        sessionId: 'session-1',
        hasQueued: true
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(notificationMocks.setSessionQueuedState).toHaveBeenCalledWith('session-1', true)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('queued-state-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend updaterCheckForUpdate commands to the updater service', async () => {
    const child = new FakeChildProcess()
    updaterMocks.checkForUpdates.mockResolvedValue(undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('updater-check-1', 'updaterCheckForUpdate', { manual: true })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(updaterMocks.checkForUpdates).toHaveBeenCalledWith({ manual: true })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('updater-check-1', { ok: true, value: undefined }),
      expect.any(Function)
    )
  })

  it('forwards backend updaterDownloadUpdate commands to the updater service', async () => {
    const child = new FakeChildProcess()
    updaterMocks.downloadUpdate.mockResolvedValue(undefined)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('updater-download-1', 'updaterDownloadUpdate'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(updaterMocks.downloadUpdate).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('updater-download-1', { ok: true, value: undefined }),
      expect.any(Function)
    )
  })

  it('forwards backend updaterInstallUpdate commands to the updater service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('updater-install-1', 'updaterInstallUpdate'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(updaterMocks.quitAndInstall).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('updater-install-1', { ok: true, value: undefined }),
      expect.any(Function)
    )
  })

  it('forwards backend updaterSetChannel commands to the updater service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('updater-set-channel-1', 'updaterSetChannel', {
        channel: 'canary'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(updaterMocks.setChannel).toHaveBeenCalledWith('canary')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('updater-set-channel-1', { ok: true, value: undefined }),
      expect.any(Function)
    )
  })

  it('forwards backend updaterGetVersion commands to the updater service', async () => {
    const child = new FakeChildProcess()
    updaterMocks.getVersion.mockReturnValue('1.2.3')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('updater-version-1', 'updaterGetVersion'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(updaterMocks.getVersion).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('updater-version-1', { ok: true, value: '1.2.3' }),
      expect.any(Function)
    )
  })

  it('forwards backend showPet commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('show-pet-1', 'showPet'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.createPetWindow).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('show-pet-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('acknowledges showPet without creating a pet window in headless mode', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0,
        headless: true
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('show-pet-headless-1', 'showPet'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.createPetWindow).not.toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('show-pet-headless-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend hidePet commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('hide-pet-1', 'hidePet'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.destroyPetWindow).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('hide-pet-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend publishPetStatus commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    const payload = { state: 'working' as const, sourceWorktreeId: 'worktree-1' }
    child.emit(
      'message',
      makeDesktopCommandRequest('publish-pet-status-1', 'publishPetStatus', payload)
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.forwardStatusToPet).toHaveBeenCalledWith(payload)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('publish-pet-status-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend setPetIgnoreMouse commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('set-pet-ignore-mouse-1', 'setPetIgnoreMouse', {
        ignore: true
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.setPetIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('set-pet-ignore-mouse-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend beginPetPointerInteraction commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('begin-pet-pointer-interaction-1', 'beginPetPointerInteraction')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.beginPetPointerInteraction).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('begin-pet-pointer-interaction-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend endPetPointerInteraction commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('end-pet-pointer-interaction-1', 'endPetPointerInteraction')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.endPetPointerInteraction).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('end-pet-pointer-interaction-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend movePet commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('move-pet-1', 'movePet', { x: 42, y: 84 }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.movePetWindow).toHaveBeenCalledWith({ x: 42, y: 84 })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('move-pet-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend focusMainFromPet commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('focus-main-from-pet-1', 'focusMainFromPet', {
        worktreeId: 'worktree-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.focusMainWindowFromPet).toHaveBeenCalledWith('worktree-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('focus-main-from-pet-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend getPetConfig commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()
    const config = {
      settings: {
        enabled: true,
        petId: 'bee',
        size: 'M',
        opacity: 1,
        hasHatched: false
      },
      position: { x: 42, y: 84 },
      manifest: {
        id: 'bee',
        name: 'Bee',
        version: '1.0.0',
        assets: {
          idle: 'assets/bee.png',
          working: 'assets/bee.png',
          question: 'assets/bee.png',
          permission: 'assets/bee.png',
          plan_ready: 'assets/bee.png'
        }
      }
    }
    petWindowMocks.getPetConfig.mockReturnValue(config)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('get-pet-config-1', 'getPetConfig'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.getPetConfig).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('get-pet-config-1', { ok: true, value: config }),
      expect.any(Function)
    )
  })

  it('forwards backend getCurrentPetStatus commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()
    const status = { state: 'working' as const, sourceWorktreeId: 'worktree-1' }
    petWindowMocks.getCurrentPetStatus.mockReturnValue(status)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('get-current-pet-status-1', 'getCurrentPetStatus')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.getCurrentPetStatus).toHaveBeenCalledOnce()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('get-current-pet-status-1', { ok: true, value: status }),
      expect.any(Function)
    )
  })

  it('forwards backend updatePetSettings commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('update-pet-settings-1', 'updatePetSettings', {
        enabled: true,
        size: 'L',
        opacity: 0.75
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.updatePetSettings).toHaveBeenCalledWith({
      enabled: true,
      size: 'L',
      opacity: 0.75
    })
    expect(petWindowMocks.createPetWindow).toHaveBeenCalledOnce()
    expect(petWindowMocks.destroyPetWindow).not.toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('update-pet-settings-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('updates pet settings without creating a pet window in headless mode', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0,
        headless: true
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('update-pet-settings-headless-1', 'updatePetSettings', {
        enabled: true,
        size: 'L',
        opacity: 0.75
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.updatePetSettings).toHaveBeenCalledWith({
      enabled: true,
      size: 'L',
      opacity: 0.75
    })
    expect(petWindowMocks.createPetWindow).not.toHaveBeenCalled()
    expect(petWindowMocks.destroyPetWindow).not.toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('update-pet-settings-headless-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend markPetHatched commands to the pet window implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit('message', makeDesktopCommandRequest('mark-pet-hatched-1', 'markPetHatched'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(petWindowMocks.persistPetSettings).toHaveBeenCalledWith({ hasHatched: true })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('mark-pet-hatched-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend createResponseLog commands to the response logger implementation', async () => {
    const child = new FakeChildProcess()
    responseLoggerMocks.createResponseLog.mockReturnValue('/tmp/hive-response-log.jsonl')

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('create-response-log-1', 'createResponseLog', {
        sessionId: 'session-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(responseLoggerMocks.createResponseLog).toHaveBeenCalledWith('session-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('create-response-log-1', {
        ok: true,
        value: '/tmp/hive-response-log.jsonl'
      }),
      expect.any(Function)
    )
  })

  it('forwards backend appendResponseLog commands to the response logger implementation', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    const data = { type: 'assistant_delta', text: 'hello' }
    child.emit(
      'message',
      makeDesktopCommandRequest('append-response-log-1', 'appendResponseLog', {
        filePath: '/tmp/hive-response-log.jsonl',
        data
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(responseLoggerMocks.appendResponseLog).toHaveBeenCalledWith(
      '/tmp/hive-response-log.jsonl',
      data
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('append-response-log-1', { ok: true }),
      expect.any(Function)
    )
  })

  it('forwards backend saveAttachment commands to the attachment storage implementation', async () => {
    const child = new FakeChildProcess()
    attachmentStorageMocks.saveAttachment.mockResolvedValue({
      success: true,
      filePath: '/tmp/hive/.hive/attachments/image.png'
    })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('save-attachment-1', 'saveAttachment', {
        dataBase64: 'aGVsbG8=',
        originalName: 'image.png'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(attachmentStorageMocks.saveAttachment).toHaveBeenCalledWith(
      Buffer.from('hello'),
      'image.png'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('save-attachment-1', {
        ok: true,
        value: { success: true, filePath: '/tmp/hive/.hive/attachments/image.png' }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend deleteAttachment commands to the attachment storage implementation', async () => {
    const child = new FakeChildProcess()
    attachmentStorageMocks.deleteAttachment.mockResolvedValue({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('delete-attachment-1', 'deleteAttachment', {
        filePath: '/tmp/hive/.hive/attachments/image.png'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(attachmentStorageMocks.deleteAttachment).toHaveBeenCalledWith(
      '/tmp/hive/.hive/attachments/image.png'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('delete-attachment-1', { ok: true, value: { success: true } }),
      expect.any(Function)
    )
  })

  it('forwards backend settingsOpenWithEditor commands to the settings handler implementation', async () => {
    const child = new FakeChildProcess()
    settingsHandlerMocks.openPathWithEditor.mockReturnValue({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('settings-open-editor-1', 'settingsOpenWithEditor', {
        worktreePath: '/tmp/hive',
        editorId: 'custom',
        customCommand: 'code'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(settingsHandlerMocks.openPathWithEditor).toHaveBeenCalledWith(
      '/tmp/hive',
      'custom',
      'code'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('settings-open-editor-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend settingsOpenWithTerminal commands to the settings handler implementation', async () => {
    const child = new FakeChildProcess()
    settingsHandlerMocks.openPathWithTerminal.mockReturnValue({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('settings-open-terminal-1', 'settingsOpenWithTerminal', {
        worktreePath: '/tmp/hive',
        terminalId: 'custom',
        customCommand: 'ghostty'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(settingsHandlerMocks.openPathWithTerminal).toHaveBeenCalledWith(
      '/tmp/hive',
      'custom',
      'ghostty'
    )
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('settings-open-terminal-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend watchFileTree commands to the file tree watcher implementation', async () => {
    const child = new FakeChildProcess()
    fileTreeHandlerMocks.startFileTreeWatcher.mockReturnValue({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('watch-file-tree-1', 'watchFileTree', {
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(fileTreeHandlerMocks.startFileTreeWatcher).toHaveBeenCalledWith('/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('watch-file-tree-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend unwatchFileTree commands to the file tree watcher implementation', async () => {
    const child = new FakeChildProcess()
    fileTreeHandlerMocks.stopFileTreeWatcher.mockResolvedValue({ success: true })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('unwatch-file-tree-1', 'unwatchFileTree', {
        worktreePath: '/tmp/hive'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(fileTreeHandlerMocks.stopFileTreeWatcher).toHaveBeenCalledWith('/tmp/hive')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('unwatch-file-tree-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend killScript commands to the legacy script runner', async () => {
    const child = new FakeChildProcess()
    scriptRunnerMocks.killProcess.mockResolvedValue(true)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('kill-script-1', 'killScript', { worktreeId: 'worktree-1' })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(scriptRunnerMocks.killProcess).toHaveBeenCalledWith('script:run:worktree-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('kill-script-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalResize commands to the legacy PTY service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-resize-1', 'terminalResize', {
        terminalId: 'terminal-1',
        cols: 120,
        rows: 32
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ptyServiceMocks.resize).toHaveBeenCalledWith('terminal-1', 120, 32)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-resize-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalDestroy commands to the legacy terminal cleanup helper', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-destroy-1', 'terminalDestroy', {
        terminalId: 'terminal-1'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(terminalHandlerMocks.destroyNodePtyTerminal).toHaveBeenCalledWith('terminal-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-destroy-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalWrite commands to the legacy PTY service', async () => {
    const child = new FakeChildProcess()
    ptyServiceMocks.has.mockReturnValue(true)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-write-1', 'terminalWrite', {
        terminalId: 'terminal-1',
        data: 'ls\n'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ptyServiceMocks.write).toHaveBeenCalledWith('terminal-1', 'ls\n')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-write-1', {
        ok: true,
        value: { success: true }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalCreateClaudeCli commands to the legacy terminal handler', async () => {
    const child = new FakeChildProcess()
    terminalHandlerMocks.createClaudeCliTerminal.mockResolvedValue({
      success: true,
      cols: 120,
      rows: 32
    })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-create-claude-cli-1', 'terminalCreateClaudeCli', {
        sessionId: 'session-1',
        opts: { pendingPrompt: 'continue' }
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(terminalHandlerMocks.createClaudeCliTerminal).toHaveBeenCalledWith('session-1', {
      pendingPrompt: 'continue'
    })
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-create-claude-cli-1', {
        ok: true,
        value: { success: true, cols: 120, rows: 32 }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyInit commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    ghosttyServiceMocks.init.mockReturnValue({ success: true, version: '1.0.0' })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-init-1', 'terminalGhosttyInit')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.init).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-init-1', {
        ok: true,
        value: { success: true, version: '1.0.0' }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyIsAvailable commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    ghosttyServiceMocks.isAvailable.mockReturnValue(true)
    ghosttyServiceMocks.isInitialized.mockReturnValue(false)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-is-available-1', 'terminalGhosttyIsAvailable')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.loadAddon).toHaveBeenCalled()
    expect(ghosttyServiceMocks.isAvailable).toHaveBeenCalled()
    expect(ghosttyServiceMocks.isInitialized).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-is-available-1', {
        ok: true,
        value: {
          available: true,
          initialized: false,
          platform: process.platform
        }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyCreateSurface commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    const rect = { x: 10, y: 20, w: 800, h: 600 }
    const opts = { cwd: '/tmp/project', shell: '/bin/zsh', scaleFactor: 2, fontSize: 14 }
    ghosttyServiceMocks.createSurface.mockReturnValue({ success: true, surfaceId: 42 })

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'terminal-ghostty-create-surface-1',
        'terminalGhosttyCreateSurface',
        {
          terminalId: 'terminal-1',
          rect,
          opts
        }
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.createSurface).toHaveBeenCalledWith('terminal-1', rect, opts)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-create-surface-1', {
        ok: true,
        value: { success: true, surfaceId: 42 }
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttySetFrame commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    const rect = { x: 10, y: 20, w: 800, h: 600 }

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-set-frame-1', 'terminalGhosttySetFrame', {
        terminalId: 'terminal-1',
        rect
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.setFrame).toHaveBeenCalledWith('terminal-1', rect)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-set-frame-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttySetSize commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-set-size-1', 'terminalGhosttySetSize', {
        terminalId: 'terminal-1',
        width: 800,
        height: 600
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.setSize).toHaveBeenCalledWith('terminal-1', 800, 600)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-set-size-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyKeyEvent commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    const event = {
      action: 1,
      keycode: 36,
      mods: 2,
      consumedMods: 0,
      text: '\r',
      unshiftedCodepoint: 13,
      composing: false
    }
    ghosttyServiceMocks.keyEvent.mockReturnValue(true)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-key-event-1', 'terminalGhosttyKeyEvent', {
        terminalId: 'terminal-1',
        event
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.keyEvent).toHaveBeenCalledWith('terminal-1', event)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-key-event-1', {
        ok: true,
        value: true
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyMouseButton commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-mouse-button-1', 'terminalGhosttyMouseButton', {
        terminalId: 'terminal-1',
        state: 1,
        button: 0,
        mods: 2
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.mouseButton).toHaveBeenCalledWith('terminal-1', 1, 0, 2)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-mouse-button-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyMousePos commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-mouse-pos-1', 'terminalGhosttyMousePos', {
        terminalId: 'terminal-1',
        x: 320,
        y: 180,
        mods: 2
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.mousePos).toHaveBeenCalledWith('terminal-1', 320, 180, 2)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-mouse-pos-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyMouseScroll commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-mouse-scroll-1', 'terminalGhosttyMouseScroll', {
        terminalId: 'terminal-1',
        dx: 0,
        dy: -120,
        mods: 2
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.mouseScroll).toHaveBeenCalledWith('terminal-1', 0, -120, 2)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-mouse-scroll-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttySetFocus commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-set-focus-1', 'terminalGhosttySetFocus', {
        terminalId: 'terminal-1',
        focused: true
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.setFocus).toHaveBeenCalledWith('terminal-1', true)
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-set-focus-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyPasteText commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-paste-text-1', 'terminalGhosttyPasteText', {
        terminalId: 'terminal-1',
        text: 'hello\n'
      })
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.pasteText).toHaveBeenCalledWith('terminal-1', 'hello\n')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-paste-text-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyFocusDiagnostics commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()
    const diagnostics = [
      {
        surfaceId: 42,
        subviewCount: 2,
        firstResponderClass: 'GhosttyView',
        isHostView: true,
        isDescendant: true,
        hasWindow: true
      }
    ]
    ghosttyServiceMocks.focusDiagnostics.mockReturnValue(diagnostics)

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'terminal-ghostty-focus-diagnostics-1',
        'terminalGhosttyFocusDiagnostics'
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.focusDiagnostics).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-focus-diagnostics-1', {
        ok: true,
        value: diagnostics
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyDestroySurface commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest(
        'terminal-ghostty-destroy-surface-1',
        'terminalGhosttyDestroySurface',
        { terminalId: 'terminal-1' }
      )
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.destroySurface).toHaveBeenCalledWith('terminal-1')
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-destroy-surface-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })

  it('forwards backend terminalGhosttyShutdown commands to the Ghostty service', async () => {
    const child = new FakeChildProcess()

    await startDesktopBackend(
      {
        executablePath: '/electron',
        entryPath: '/app/server.js',
        cwd: '/app',
        baseDir: mkdtempSync(join(tmpdir(), 'hive-backend-manager-')),
        port: 0
      },
      {
        spawnProcess: vi.fn(() => child as never),
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
        logger: makeLogger()
      }
    )

    child.emit(
      'message',
      makeDesktopCommandRequest('terminal-ghostty-shutdown-1', 'terminalGhosttyShutdown')
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(ghosttyServiceMocks.shutdown).toHaveBeenCalled()
    expect(child.send).toHaveBeenCalledWith(
      makeDesktopCommandResult('terminal-ghostty-shutdown-1', {
        ok: true,
        value: undefined
      }),
      expect.any(Function)
    )
  })
})

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})
