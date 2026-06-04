import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { DetectedApp } from '../../shared/types/settings'
import { makeEventBus } from '../events/event-bus'
import type { SettingsOpsRpcService } from '../rpc/domains/settings-ops'
import { makeRpcRouter } from '../rpc/router'

describe('settings ops RPC mocked provider', () => {
  it('routes settingsOps.detectEditors to the injected provider service', async () => {
    const editors: DetectedApp[] = [
      {
        id: 'vscode',
        name: 'Visual Studio Code',
        command: '/usr/bin/code',
        available: true
      }
    ]
    const detectEditors = vi.fn(() => Effect.succeed(editors))
    const service = { detectEditors } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-detect-editors-1',
        method: 'settingsOps.detectEditors',
        params: {}
      })
    )

    expect(detectEditors).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-detect-editors-1',
      ok: true,
      value: editors
    })
  })

  it('validates settingsOps.detectEditors params before calling the provider service', async () => {
    const detectEditors = vi.fn(() => Effect.succeed([]))
    const service = { detectEditors } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-detect-editors-invalid',
        method: 'settingsOps.detectEditors',
        params: { unexpected: true }
      })
    )

    expect(detectEditors).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-detect-editors-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes settingsOps.detectTerminals to the injected provider service', async () => {
    const terminals: DetectedApp[] = [
      {
        id: 'terminal',
        name: 'Default Terminal',
        command: 'x-terminal-emulator',
        available: true
      }
    ]
    const detectTerminals = vi.fn(() => Effect.succeed(terminals))
    const service = { detectTerminals } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-detect-terminals-1',
        method: 'settingsOps.detectTerminals',
        params: {}
      })
    )

    expect(detectTerminals).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-detect-terminals-1',
      ok: true,
      value: terminals
    })
  })

  it('validates settingsOps.detectTerminals params before calling the provider service', async () => {
    const detectTerminals = vi.fn(() => Effect.succeed([]))
    const service = { detectTerminals } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-detect-terminals-invalid',
        method: 'settingsOps.detectTerminals',
        params: { unexpected: true }
      })
    )

    expect(detectTerminals).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-detect-terminals-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes settingsOps.openWithEditor to the injected provider service', async () => {
    const result = { success: true }
    const openWithEditor = vi.fn(() => Effect.succeed(result))
    const service = { openWithEditor } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-open-with-editor-1',
        method: 'settingsOps.openWithEditor',
        params: {
          worktreePath: '/tmp/hive-feature',
          editorId: 'custom',
          customCommand: 'code'
        }
      })
    )

    expect(openWithEditor).toHaveBeenCalledWith('/tmp/hive-feature', 'custom', 'code')
    expect(response).toEqual({
      id: 'settings-open-with-editor-1',
      ok: true,
      value: result
    })
  })

  it('validates settingsOps.openWithEditor params before calling the provider service', async () => {
    const openWithEditor = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openWithEditor } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-open-with-editor-invalid',
        method: 'settingsOps.openWithEditor',
        params: {
          worktreePath: '',
          editorId: 'vscode'
        }
      })
    )

    expect(openWithEditor).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-open-with-editor-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes settingsOps.openWithTerminal to the injected provider service', async () => {
    const result = { success: true }
    const openWithTerminal = vi.fn(() => Effect.succeed(result))
    const service = { openWithTerminal } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-open-with-terminal-1',
        method: 'settingsOps.openWithTerminal',
        params: {
          worktreePath: '/tmp/hive-feature',
          terminalId: 'custom',
          customCommand: 'ghostty'
        }
      })
    )

    expect(openWithTerminal).toHaveBeenCalledWith('/tmp/hive-feature', 'custom', 'ghostty')
    expect(response).toEqual({
      id: 'settings-open-with-terminal-1',
      ok: true,
      value: result
    })
  })

  it('validates settingsOps.openWithTerminal params before calling the provider service', async () => {
    const openWithTerminal = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openWithTerminal } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-open-with-terminal-invalid',
        method: 'settingsOps.openWithTerminal',
        params: {
          worktreePath: '/tmp/hive-feature',
          terminalId: ''
        }
      })
    )

    expect(openWithTerminal).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-open-with-terminal-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes settingsOps.getAll to the injected provider service', async () => {
    const settings = {
      editor: 'vscode',
      terminal: 'ghostty'
    }
    const getAll = vi.fn(() => Effect.succeed(settings))
    const service = { getAll } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-get-all-1',
        method: 'settingsOps.getAll',
        params: {}
      })
    )

    expect(getAll).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-get-all-1',
      ok: true,
      value: settings
    })
  })

  it('validates settingsOps.getAll params before calling the provider service', async () => {
    const getAll = vi.fn(() => Effect.succeed({ unused: 'true' }))
    const service = { getAll } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-get-all-invalid',
        method: 'settingsOps.getAll',
        params: { unexpected: true }
      })
    )

    expect(getAll).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-get-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes settingsOps.getCustomCommandsFilePath to the injected provider service', async () => {
    const getCustomCommandsFilePath = vi.fn(() =>
      Effect.succeed('/Users/mor/.hive/custom-commands.json')
    )
    const service = { getCustomCommandsFilePath } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-custom-commands-path-1',
        method: 'settingsOps.getCustomCommandsFilePath',
        params: {}
      })
    )

    expect(getCustomCommandsFilePath).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-custom-commands-path-1',
      ok: true,
      value: '/Users/mor/.hive/custom-commands.json'
    })
  })

  it('routes settingsOps.loadCustomCommandsFile to the injected provider service', async () => {
    const result = {
      success: true,
      commands: [{ id: 'cmd-1', name: 'Run tests', prompt: 'Run {{project.name}} tests' }],
      mtime: 123
    }
    const loadCustomCommandsFile = vi.fn(() => Effect.succeed(result))
    const service = { loadCustomCommandsFile } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-load-custom-commands-1',
        method: 'settingsOps.loadCustomCommandsFile',
        params: {}
      })
    )

    expect(loadCustomCommandsFile).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-load-custom-commands-1',
      ok: true,
      value: result
    })
  })

  it('routes settingsOps.saveCustomCommandsFile to the injected provider service', async () => {
    const commands = [{ id: 'cmd-1', name: 'Run tests', prompt: 'Run {{project.name}} tests' }]
    const result = { success: true, mtime: 123 }
    const saveCustomCommandsFile = vi.fn(() => Effect.succeed(result))
    const service = { saveCustomCommandsFile } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-save-custom-commands-1',
        method: 'settingsOps.saveCustomCommandsFile',
        params: { commands }
      })
    )

    expect(saveCustomCommandsFile).toHaveBeenCalledWith(commands)
    expect(response).toEqual({
      id: 'settings-save-custom-commands-1',
      ok: true,
      value: result
    })
  })

  it('routes settingsOps.reloadCustomCommands to the injected provider service', async () => {
    const result = { success: true, count: 1, mtime: 123 }
    const reloadCustomCommands = vi.fn(() => Effect.succeed(result))
    const service = { reloadCustomCommands } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-reload-custom-commands-1',
        method: 'settingsOps.reloadCustomCommands',
        params: {}
      })
    )

    expect(reloadCustomCommands).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'settings-reload-custom-commands-1',
      ok: true,
      value: result
    })
  })

  it('validates custom command file operation params before calling the provider service', async () => {
    const loadCustomCommandsFile = vi.fn(() => Effect.succeed({ success: true, commands: [] }))
    const service = { loadCustomCommandsFile } as unknown as SettingsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'settings-load-custom-commands-invalid',
        method: 'settingsOps.loadCustomCommandsFile',
        params: { unexpected: true }
      })
    )

    expect(loadCustomCommandsFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'settings-load-custom-commands-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
