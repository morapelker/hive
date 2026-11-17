import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_UPDATED_CHANNEL } from '@shared/settings-events'
import type {
  DevFolderMovePlan,
  DevFolderMoveResult,
  DevFolderState,
  SetDevFolderResult
} from '@shared/types/dev-folder'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { settingsApi } from '../settings-api'

describe('settingsApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes detectEditors through the renderer RPC client', async () => {
    const editors = [
      {
        id: 'vscode',
        name: 'Visual Studio Code',
        command: 'code',
        available: true
      }
    ]
    const request = vi.fn().mockResolvedValue(editors)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.detectEditors()).resolves.toBe(editors)
    expect(request).toHaveBeenCalledWith('settingsOps.detectEditors', {})
  })

  it('routes detectTerminals through the renderer RPC client', async () => {
    const terminals = [
      {
        id: 'ghostty',
        name: 'Ghostty',
        command: 'ghostty',
        available: true
      }
    ]
    const request = vi.fn().mockResolvedValue(terminals)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.detectTerminals()).resolves.toBe(terminals)
    expect(request).toHaveBeenCalledWith('settingsOps.detectTerminals', {})
  })

  it('routes getAll through the renderer RPC client', async () => {
    const settings = {
      theme: 'dark',
      editor: 'vscode'
    }
    const request = vi.fn().mockResolvedValue(settings)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.getAll()).resolves.toBe(settings)
    expect(request).toHaveBeenCalledWith('settingsOps.getAll', {})
  })

  it('routes getCustomCommandsFilePath through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('/Users/mor/.hive/custom-commands.json')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.getCustomCommandsFilePath()).resolves.toBe(
      '/Users/mor/.hive/custom-commands.json'
    )
    expect(request).toHaveBeenCalledWith('settingsOps.getCustomCommandsFilePath', {})
  })

  it('routes loadCustomCommandsFile through the renderer RPC client', async () => {
    const result = {
      success: true,
      commands: [{ id: 'cmd-1', name: 'Run tests', prompt: 'Run {{project.name}} tests' }],
      mtime: 123
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.loadCustomCommandsFile()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.loadCustomCommandsFile', {})
  })

  it('routes saveCustomCommandsFile through the renderer RPC client', async () => {
    const commands = [{ id: 'cmd-1', name: 'Run tests', prompt: 'Run {{project.name}} tests' }]
    const result = { success: true, mtime: 123 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.saveCustomCommandsFile(commands)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.saveCustomCommandsFile', { commands })
  })

  it('routes reloadCustomCommands through the renderer RPC client', async () => {
    const result = { success: true, count: 1, mtime: 123 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.reloadCustomCommands()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.reloadCustomCommands', {})
  })

  it('routes openWithTerminal through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      settingsApi.openWithTerminal('/tmp/hive-feature', 'custom', 'ghostty --working-directory')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.openWithTerminal', {
      worktreePath: '/tmp/hive-feature',
      terminalId: 'custom',
      customCommand: 'ghostty --working-directory'
    })
  })

  it('routes openWithEditor through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.openWithEditor('/tmp/hive-feature', 'custom', 'code')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('settingsOps.openWithEditor', {
      worktreePath: '/tmp/hive-feature',
      editorId: 'custom',
      customCommand: 'code'
    })
  })

  it('omits customCommand for non-custom editor opens', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.openWithEditor('/tmp/hive-feature', 'vscode')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.openWithEditor', {
      worktreePath: '/tmp/hive-feature',
      editorId: 'vscode'
    })
  })

  it('omits customCommand for non-custom terminal opens', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(settingsApi.openWithTerminal('/tmp/hive-feature', 'system')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('settingsOps.openWithTerminal', {
      worktreePath: '/tmp/hive-feature',
      terminalId: 'system'
    })
  })

  describe('the dev folder', () => {
    const state: DevFolderState = {
      path: '/Users/me/Dev',
      isDefault: false,
      defaultPath: '/Users/me/hive-projects',
      exists: true,
      previousPaths: ['/Users/me/hive-projects'],
      leftBehind: { count: 2, folders: ['/Users/me/hive-projects'] }
    }

    it('reads the dev folder with no params', async () => {
      const request = vi.fn().mockResolvedValue(state)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(settingsApi.getDevFolder()).resolves.toBe(state)
      expect(request).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledWith('settingsOps.getDevFolder', {})
    })

    it('sets the dev folder to a path, sent as it was given', async () => {
      const result: SetDevFolderResult = { success: true, state }
      const request = vi.fn().mockResolvedValue(result)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(settingsApi.setDevFolder(' ~/Dev folder ')).resolves.toBe(result)
      expect(request).toHaveBeenCalledWith('settingsOps.setDevFolder', { path: ' ~/Dev folder ' })
    })

    it('goes back to the default folder with a null path', async () => {
      const result: SetDevFolderResult = { success: true, state: { ...state, isDefault: true } }
      const request = vi.fn().mockResolvedValue(result)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(settingsApi.setDevFolder(null)).resolves.toBe(result)
      expect(request).toHaveBeenCalledWith('settingsOps.setDevFolder', { path: null })
    })

    it('hands a refusal back as the answer, not as a rejection', async () => {
      const refusal: SetDevFolderResult = {
        success: false,
        error:
          'The dev folder cannot be your home folder: choose a folder inside it, such as ~/Dev.'
      }
      const request = vi.fn().mockResolvedValue(refusal)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(settingsApi.setDevFolder('~')).resolves.toBe(refusal)
    })

    it('asks for the plan of "Move projects" with no params', async () => {
      const plan: DevFolderMovePlan = { devFolder: '/Users/me/Dev', sources: [], candidates: [] }
      const request = vi.fn().mockResolvedValue(plan)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(settingsApi.planDevFolderMove()).resolves.toBe(plan)
      expect(request).toHaveBeenCalledWith('settingsOps.planDevFolderMove', {})
    })

    it('moves one project, naming the two params the server accepts and nothing else', async () => {
      const result: DevFolderMoveResult = {
        projectId: 'p1',
        projectName: 'app',
        action: 'moved',
        fromPath: '/Users/me/hive-projects/app',
        toPath: '/Users/me/Dev/app',
        skipReason: null,
        detail: null,
        warnings: [],
        movedPaths: [{ from: '/Users/me/hive-projects/app', to: '/Users/me/Dev/app' }]
      }
      const request = vi.fn().mockResolvedValue(result)
      setRendererRpcClient({ request, subscribe: vi.fn() })

      // A plan row has more fields than the call takes; the server refuses unknown keys.
      const row = {
        projectId: 'p1',
        expectedToPath: '/Users/me/Dev/app',
        projectName: 'app',
        source: '/Users/me/hive-projects'
      }
      await expect(settingsApi.moveProjectToDevFolder(row)).resolves.toBe(result)
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0]).toEqual([
        'settingsOps.moveProjectToDevFolder',
        { projectId: 'p1', expectedToPath: '/Users/me/Dev/app' }
      ])
    })

    it('lets a failed call reject, for the caller to decide what it means', async () => {
      const request = vi.fn().mockRejectedValue(new Error('connection closed'))
      setRendererRpcClient({ request, subscribe: vi.fn() })

      await expect(
        settingsApi.moveProjectToDevFolder({ projectId: 'p1', expectedToPath: '/x/app' })
      ).rejects.toThrow('connection closed')
      await expect(settingsApi.getDevFolder()).rejects.toThrow('connection closed')
    })
  })

  it('routes settings updates through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = settingsApi.onSettingsUpdated(callback)
    const payload = { commandFilter: { enabled: true } }

    listener?.({ channel: SETTINGS_UPDATED_CHANNEL, payload })

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(SETTINGS_UPDATED_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledWith(payload)
  })
})
