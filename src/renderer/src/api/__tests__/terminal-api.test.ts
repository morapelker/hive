import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { terminalApi } from '../terminal-api'
import type { ServerEvent } from '@shared/rpc/protocol'

describe('terminalApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes create through the renderer RPC client', async () => {
    const createResult = {
      success: true,
      cols: 120,
      rows: 32
    }
    const request = vi.fn().mockResolvedValue(createResult)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.create('terminal-1', '/tmp/project', '/bin/zsh')).resolves.toEqual({
      success: true,
      value: createResult
    })
    expect(request).toHaveBeenCalledWith('terminalOps.create', {
      terminalId: 'terminal-1',
      cwd: '/tmp/project',
      shell: '/bin/zsh'
    })
  })

  it('routes createClaudeCli through the renderer RPC client', async () => {
    const createResult = {
      success: true,
      cols: 120,
      rows: 32
    }
    const request = vi.fn().mockResolvedValue(createResult)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      terminalApi.createClaudeCli('session-1', { pendingPrompt: 'continue' })
    ).resolves.toEqual({
      success: true,
      value: createResult
    })
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: 'continue' }
    })
  })

  it('routes destroy through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.destroy('terminal-1')).resolves.toEqual({
      success: true,
      value: undefined
    })
    expect(request).toHaveBeenCalledWith('terminalOps.destroy', {
      terminalId: 'terminal-1'
    })
  })

  it('delivers Claude CLI prompts through terminal writes', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.sendClaudeCliPrompt('session-1', 'continue')).resolves.toEqual({
      success: true,
      value: { delivered: true }
    })
    expect(request).toHaveBeenCalledWith('terminalOps.write', {
      terminalId: 'session-1',
      data: '\x1b[200~continue\x1b[201~\r'
    })
  })

  it('reports undelivered Claude CLI prompts when the terminal write fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Terminal not found'))
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.sendClaudeCliPrompt('session-1', 'continue')).resolves.toEqual({
      success: true,
      value: { delivered: false }
    })
    expect(request).toHaveBeenCalledWith('terminalOps.write', {
      terminalId: 'session-1',
      data: '\x1b[200~continue\x1b[201~\r'
    })
  })

  it('routes write through the renderer RPC client without returning a promise', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.write('terminal-1', 'ls\n')).toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.write', {
      terminalId: 'terminal-1',
      data: 'ls\n'
    })
  })

  it('routes resize through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.resize('terminal-1', 120, 32)).resolves.toEqual({
      success: true,
      value: undefined
    })
    expect(request).toHaveBeenCalledWith('terminalOps.resize', {
      terminalId: 'terminal-1',
      cols: 120,
      rows: 32
    })
  })

  it('swallows write request rejections', async () => {
    const request = vi.fn().mockRejectedValue(new Error('terminal unavailable'))
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.write('terminal-1', 'ls\n')).toBeUndefined()
    await Promise.resolve()

    expect(request).toHaveBeenCalledWith('terminalOps.write', {
      terminalId: 'terminal-1',
      data: 'ls\n'
    })
  })

  it('subscribes to terminal data events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.onData('terminal-1', callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('terminal:data:terminal-1', expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: 'terminal:data:terminal-1', payload: 'hello' })
    listener?.({ channel: 'terminal:data:terminal-1', payload: { data: 'ignored' } })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('hello')
  })

  it('subscribes to terminal exit events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.onExit('terminal-1', callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('terminal:exit:terminal-1', expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: 'terminal:exit:terminal-1', payload: 130 })
    listener?.({ channel: 'terminal:exit:terminal-1', payload: '130' })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(130)
  })

  it('subscribes to Claude session id events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.onClaudeSessionId('session-1', callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(
      'terminal:claude-session-id:session-1',
      expect.any(Function)
    )

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: 'terminal:claude-session-id:session-1',
      payload: 'claude-session-abc'
    })
    listener?.({ channel: 'terminal:claude-session-id:session-1', payload: 42 })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('claude-session-abc')
  })

  it('subscribes to Claude CLI status events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()
    const payload = {
      sessionId: 'session-1',
      status: 'plan_ready',
      metadata: {
        hookEventName: 'PreToolUse',
        hookPath: 'tool',
        toolName: 'ExitPlanMode',
        plan: '# Plan'
      }
    } as const

    setRendererRpcClient({ request, subscribe })

    expect(terminalApi.onClaudeCliStatus(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('claude-cli:status', expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: 'claude-cli:status', payload })
    listener?.({
      channel: 'claude-cli:status',
      payload: { sessionId: 'session-1', status: 'busy' }
    })
    listener?.({
      channel: 'claude-cli:status',
      payload: { sessionId: 'session-1', status: 'working', metadata: 'invalid' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('routes ghosttyPasteText through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyPasteText('terminal-1', 'hello\n')).resolves.toEqual({
      success: true,
      value: undefined
    })
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyPasteText', {
      terminalId: 'terminal-1',
      text: 'hello\n'
    })
  })

  it('routes ghosttyFocusDiagnostics through the renderer RPC client', async () => {
    const diagnostics = [
      {
        surfaceId: 1,
        subviewCount: 2,
        firstResponderClass: 'GhosttyView',
        isHostView: true,
        isDescendant: true,
        hasWindow: true
      }
    ]
    const request = vi.fn().mockResolvedValue(diagnostics)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyFocusDiagnostics()).resolves.toEqual(diagnostics)
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyFocusDiagnostics', {})
  })

  it('routes getConfig through the renderer RPC client', async () => {
    const config = {
      fontFamily: 'Berkeley Mono',
      fontSize: 14,
      shell: '/bin/zsh'
    }
    const request = vi.fn().mockResolvedValue(config)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.getConfig()).resolves.toEqual({
      success: true,
      value: config
    })
    expect(request).toHaveBeenCalledWith('terminalOps.getConfig', {})
  })

  it('routes ghosttyIsAvailable through the renderer RPC client', async () => {
    const availability = {
      available: true,
      initialized: true,
      platform: 'darwin'
    }
    const request = vi.fn().mockResolvedValue(availability)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyIsAvailable()).resolves.toEqual(availability)
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyIsAvailable', {})
  })

  it('routes ghosttyInit through the renderer RPC client', async () => {
    const initResult = {
      success: true,
      version: '1.0.0'
    }
    const request = vi.fn().mockResolvedValue(initResult)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyInit()).resolves.toEqual(initResult)
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyInit', {})
  })

  it('routes ghosttyCreateSurface through the renderer RPC client', async () => {
    const createResult = {
      success: true,
      surfaceId: 42
    }
    const rect = { x: 10, y: 20, w: 800, h: 600 }
    const opts = {
      cwd: '/repo',
      shell: '/bin/zsh',
      scaleFactor: 2,
      fontSize: 14
    }
    const request = vi.fn().mockResolvedValue(createResult)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyCreateSurface('terminal-1', rect, opts)).resolves.toEqual(
      createResult
    )
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyCreateSurface', {
      terminalId: 'terminal-1',
      rect,
      opts
    })
  })

  it('routes ghosttyDestroySurface through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyDestroySurface('terminal-1')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyDestroySurface', {
      terminalId: 'terminal-1'
    })
  })

  it('routes ghosttyShutdown through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyShutdown()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyShutdown', {})
  })

  it('routes ghosttySetFocus through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttySetFocus('terminal-1', true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttySetFocus', {
      terminalId: 'terminal-1',
      focused: true
    })
  })

  it('routes ghosttySetFrame through the renderer RPC client', async () => {
    const rect = { x: -10000, y: -10000, w: 640, h: 360 }
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttySetFrame('terminal-1', rect)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttySetFrame', {
      terminalId: 'terminal-1',
      rect
    })
  })

  it('routes ghosttySetSize through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttySetSize('terminal-1', 800, 600)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttySetSize', {
      terminalId: 'terminal-1',
      width: 800,
      height: 600
    })
  })

  it('routes ghosttyKeyEvent through the renderer RPC client', async () => {
    const event = {
      action: 1,
      keycode: 36,
      mods: 2,
      consumedMods: 0,
      text: '\r',
      unshiftedCodepoint: 13,
      composing: false
    }
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyKeyEvent('terminal-1', event)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyKeyEvent', {
      terminalId: 'terminal-1',
      event
    })
  })

  it('routes ghosttyMouseButton through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyMouseButton('terminal-1', 1, 0, 2)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyMouseButton', {
      terminalId: 'terminal-1',
      state: 1,
      button: 0,
      mods: 2
    })
  })

  it('routes ghosttyMousePos through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyMousePos('terminal-1', 320, 180, 2)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyMousePos', {
      terminalId: 'terminal-1',
      x: 320,
      y: 180,
      mods: 2
    })
  })

  it('routes ghosttyMouseScroll through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(terminalApi.ghosttyMouseScroll('terminal-1', 0, -120, 2)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('terminalOps.ghosttyMouseScroll', {
      terminalId: 'terminal-1',
      dx: 0,
      dy: -120,
      mods: 2
    })
  })
})
