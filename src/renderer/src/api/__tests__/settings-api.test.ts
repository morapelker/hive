import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_UPDATED_CHANNEL } from '@shared/settings-events'
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
