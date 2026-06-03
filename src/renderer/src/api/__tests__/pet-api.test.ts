import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '@shared/pet-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { petApi } from '../pet-api'

describe('petApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes show through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(petApi.show()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.show', {})
  })

  it('routes hide through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(petApi.hide()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.hide', {})
  })

  it('routes focusMain through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(petApi.focusMain({ worktreeId: 'worktree-1' })).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.focusMain', { worktreeId: 'worktree-1' })
  })

  it('routes setIgnoreMouse through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(petApi.setIgnoreMouse(true)).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.setIgnoreMouse', { ignore: true })
  })

  it('routes beginPointerInteraction through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(petApi.beginPointerInteraction()).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.beginPointerInteraction', {})
  })

  it('routes endPointerInteraction through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(petApi.endPointerInteraction()).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.endPointerInteraction', {})
  })

  it('routes move through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(petApi.move({ x: 42, y: 84 })).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.move', { x: 42, y: 84 })
  })

  it('routes publishStatus through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const payload = {
      state: 'permission' as const,
      sourceWorktreeId: 'worktree-1',
      workingSessionCount: 0
    }

    setRendererRpcClient({ request, subscribe })

    expect(petApi.publishStatus(payload)).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.publishStatus', payload)
  })

  it('routes getConfig through the renderer RPC client', async () => {
    const config = {
      settings: {
        enabled: true,
        petId: 'bee',
        size: 'M' as const,
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
    const request = vi.fn().mockResolvedValue(config)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(petApi.getConfig()).resolves.toEqual(config)
    expect(request).toHaveBeenCalledWith('petOps.getConfig', {})
  })

  it('routes getCurrentStatus through the renderer RPC client', async () => {
    const status = {
      state: 'working' as const,
      sourceWorktreeId: 'worktree-1',
      workingSessionCount: 1
    }
    const request = vi.fn().mockResolvedValue(status)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(petApi.getCurrentStatus()).resolves.toEqual(status)
    expect(request).toHaveBeenCalledWith('petOps.getCurrentStatus', {})
  })

  it('routes onStatus through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const returned = petApi.onStatus(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: PET_STATUS_CHANNEL,
      payload: { state: 'working', sourceWorktreeId: 'worktree-1', workingSessionCount: 2 }
    })
    listener?.({
      channel: PET_STATUS_CHANNEL,
      payload: { state: 'sleeping', sourceWorktreeId: 'worktree-1', workingSessionCount: 1 }
    })
    listener?.({
      channel: PET_STATUS_CHANNEL,
      payload: { state: 'working', sourceWorktreeId: 'worktree-1' }
    })

    expect(subscribe).toHaveBeenCalledWith(PET_STATUS_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({
      state: 'working',
      sourceWorktreeId: 'worktree-1',
      workingSessionCount: 2
    })
    expect(returned).toBe(unsubscribe)
  })

  it('routes onSettingsUpdated through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void) => unsubscribe
    )
    const callback = vi.fn()
    const settings = {
      enabled: true,
      petId: 'bee',
      size: 'L' as const,
      opacity: 0.75,
      hasHatched: true
    }

    setRendererRpcClient({ request, subscribe })

    const returned = petApi.onSettingsUpdated(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: PET_SETTINGS_UPDATED_CHANNEL, payload: settings })
    listener?.({ channel: PET_SETTINGS_UPDATED_CHANNEL, payload: { ...settings, size: 'XL' } })

    expect(subscribe).toHaveBeenCalledWith(PET_SETTINGS_UPDATED_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(settings)
    expect(returned).toBe(unsubscribe)
  })

  it('routes onJumpToWorktree through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const returned = petApi.onJumpToWorktree(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: PET_JUMP_TO_WORKTREE_CHANNEL,
      payload: { worktreeId: 'worktree-1' }
    })
    listener?.({
      channel: PET_JUMP_TO_WORKTREE_CHANNEL,
      payload: { worktreeId: null }
    })

    expect(subscribe).toHaveBeenCalledWith(PET_JUMP_TO_WORKTREE_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ worktreeId: 'worktree-1' })
    expect(returned).toBe(unsubscribe)
  })

  it('routes markHatched through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(petApi.markHatched()).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.markHatched', {})
  })

  it('routes updateSettings through the renderer RPC client', () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const partial = { enabled: true, size: 'L' as const, opacity: 0.75 }

    setRendererRpcClient({ request, subscribe })

    expect(petApi.updateSettings(partial)).toBeUndefined()
    expect(request).toHaveBeenCalledWith('petOps.updateSettings', partial)
  })
})
