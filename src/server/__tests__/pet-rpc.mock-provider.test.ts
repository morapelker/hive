import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import { makeLivePetOpsRpcService, type PetOpsRpcService } from '../rpc/domains/pet-ops'
import { makeRpcRouter } from '../rpc/router'
import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '../../shared/pet-events'

describe('pet ops RPC mocked provider', () => {
  it('keeps live petOps.show as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      await expect(Effect.runPromise(service.show())).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.hide as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      await expect(Effect.runPromise(service.hide())).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.publishStatus as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      await expect(
        Effect.runPromise(
          service.publishStatus({
            state: 'working',
            sourceWorktreeId: 'worktree-1',
            workingSessionCount: 1
          })
        )
      ).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.setIgnoreMouse as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      await expect(Effect.runPromise(service.setIgnoreMouse(true))).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.beginPointerInteraction as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      await expect(Effect.runPromise(service.beginPointerInteraction())).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.endPointerInteraction as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.endPointerInteraction).toBeDefined()
      await expect(Effect.runPromise(service.endPointerInteraction!())).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.move as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.move).toBeDefined()
      await expect(Effect.runPromise(service.move!({ x: 42, y: 84 }))).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.focusMain as a no-op when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.focusMain).toBeDefined()
      await expect(
        Effect.runPromise(service.focusMain!({ worktreeId: 'worktree-1' }))
      ).resolves.toBeUndefined()
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.getConfig Node-safe when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.getConfig).toBeDefined()
      await expect(Effect.runPromise(service.getConfig!())).resolves.toEqual({
        settings: {
          enabled: false,
          petId: 'bee',
          size: 'M',
          opacity: 1,
          animationSpeedEnabled: false,
          animationSpeed: 5,
          hasHatched: false
        },
        position: { x: 0, y: 0 },
        manifest: {
          id: 'bee',
          name: 'Bee',
          version: '1.0.0',
          author: 'Hive',
          assets: {
            idle: 'assets/bee.png',
            working: 'assets/bee.png',
            question: 'assets/bee.png',
            permission: 'assets/bee.png',
            plan_ready: 'assets/bee.png'
          },
          lottieAssets: {
            working: 'assets/honey-bee.lottie'
          },
          lottieScale: {
            working: 2.15
          },
          defaultSize: 'M'
        }
      })
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.getCurrentStatus Node-safe when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.getCurrentStatus).toBeDefined()
      await expect(Effect.runPromise(service.getCurrentStatus!())).resolves.toEqual({
        state: 'idle',
        sourceWorktreeId: null,
        workingSessionCount: 0
      })
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.updateSettings Node-safe when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.updateSettings).toBeDefined()
      expect(service.getConfig).toBeDefined()
      await expect(
        Effect.runPromise(service.updateSettings!({ enabled: true, size: 'L', opacity: 0.75 }))
      ).resolves.toBeUndefined()
      await expect(Effect.runPromise(service.getConfig!())).resolves.toMatchObject({
        settings: {
          enabled: true,
          petId: 'bee',
          size: 'L',
          opacity: 0.75,
          hasHatched: false
        }
      })
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('keeps live petOps.markHatched Node-safe when desktop command transport is unavailable', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined
    })

    try {
      const service = makeLivePetOpsRpcService()

      expect(service.markHatched).toBeDefined()
      expect(service.updateSettings).toBeDefined()
      expect(service.getConfig).toBeDefined()
      await Effect.runPromise(service.updateSettings!({ hasHatched: false }))
      await expect(Effect.runPromise(service.markHatched!())).resolves.toBeUndefined()
      await expect(Effect.runPromise(service.getConfig!())).resolves.toMatchObject({
        settings: {
          hasHatched: true
        }
      })
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor)
      } else {
        delete process.send
      }
    }
  })

  it('routes petOps.show to the injected provider service', async () => {
    const show = vi.fn(() => Effect.succeed(undefined))
    const service = { show } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-show-1',
        method: 'petOps.show',
        params: {}
      })
    )

    expect(show).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-show-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.show params before calling the provider service', async () => {
    const show = vi.fn(() => Effect.succeed(undefined))
    const service = { show } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-show-invalid',
        method: 'petOps.show',
        params: { visible: true }
      })
    )

    expect(show).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-show-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.hide to the injected provider service', async () => {
    const hide = vi.fn(() => Effect.succeed(undefined))
    const service = { hide } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-hide-1',
        method: 'petOps.hide',
        params: {}
      })
    )

    expect(hide).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-hide-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.hide params before calling the provider service', async () => {
    const hide = vi.fn(() => Effect.succeed(undefined))
    const service = { hide } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-hide-invalid',
        method: 'petOps.hide',
        params: { force: true }
      })
    )

    expect(hide).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-hide-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.publishStatus to the injected provider service and publishes status events', async () => {
    const payload = {
      state: 'working' as const,
      sourceWorktreeId: 'worktree-1',
      workingSessionCount: 2
    }
    const events: Array<{ channel: string; payload: unknown }> = []
    const eventBus = makeEventBus()
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const publishStatus = vi.fn(() => Effect.succeed(undefined))
    const service = { publishStatus } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-publish-status-1',
        method: 'petOps.publishStatus',
        params: payload
      })
    )

    unsubscribe()
    expect(publishStatus).toHaveBeenCalledWith(payload)
    expect(events).toEqual([{ channel: PET_STATUS_CHANNEL, payload }])
    expect(response).toEqual({
      id: 'pet-publish-status-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.publishStatus params before calling the provider service', async () => {
    const eventBus = makeEventBus()
    const events: Array<{ channel: string; payload: unknown }> = []
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const publishStatus = vi.fn(() => Effect.succeed(undefined))
    const service = { publishStatus } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-publish-status-invalid',
        method: 'petOps.publishStatus',
        params: {
          state: 'sleeping',
          sourceWorktreeId: 'worktree-1'
        }
      })
    )

    unsubscribe()
    expect(publishStatus).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(response).toMatchObject({
      id: 'pet-publish-status-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.setIgnoreMouse to the injected provider service', async () => {
    const setIgnoreMouse = vi.fn(() => Effect.succeed(undefined))
    const service = { setIgnoreMouse } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-set-ignore-mouse-1',
        method: 'petOps.setIgnoreMouse',
        params: { ignore: true }
      })
    )

    expect(setIgnoreMouse).toHaveBeenCalledWith(true)
    expect(response).toEqual({
      id: 'pet-set-ignore-mouse-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.setIgnoreMouse params before calling the provider service', async () => {
    const setIgnoreMouse = vi.fn(() => Effect.succeed(undefined))
    const service = { setIgnoreMouse } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-set-ignore-mouse-invalid',
        method: 'petOps.setIgnoreMouse',
        params: { ignore: 'yes' }
      })
    )

    expect(setIgnoreMouse).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-set-ignore-mouse-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.beginPointerInteraction to the injected provider service', async () => {
    const beginPointerInteraction = vi.fn(() => Effect.succeed(undefined))
    const service = { beginPointerInteraction } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-begin-pointer-interaction-1',
        method: 'petOps.beginPointerInteraction',
        params: {}
      })
    )

    expect(beginPointerInteraction).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-begin-pointer-interaction-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.beginPointerInteraction params before calling the provider service', async () => {
    const beginPointerInteraction = vi.fn(() => Effect.succeed(undefined))
    const service = { beginPointerInteraction } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-begin-pointer-interaction-invalid',
        method: 'petOps.beginPointerInteraction',
        params: { pointerId: 'drag-1' }
      })
    )

    expect(beginPointerInteraction).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-begin-pointer-interaction-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.endPointerInteraction to the injected provider service', async () => {
    const endPointerInteraction = vi.fn(() => Effect.succeed(undefined))
    const service = { endPointerInteraction } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-end-pointer-interaction-1',
        method: 'petOps.endPointerInteraction',
        params: {}
      })
    )

    expect(endPointerInteraction).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-end-pointer-interaction-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.endPointerInteraction params before calling the provider service', async () => {
    const endPointerInteraction = vi.fn(() => Effect.succeed(undefined))
    const service = { endPointerInteraction } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-end-pointer-interaction-invalid',
        method: 'petOps.endPointerInteraction',
        params: { pointerId: 'drag-1' }
      })
    )

    expect(endPointerInteraction).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-end-pointer-interaction-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.move to the injected provider service', async () => {
    const position = { x: 42, y: 84 }
    const move = vi.fn(() => Effect.succeed(undefined))
    const service = { move } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-move-1',
        method: 'petOps.move',
        params: position
      })
    )

    expect(move).toHaveBeenCalledWith(position)
    expect(response).toEqual({
      id: 'pet-move-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.move params before calling the provider service', async () => {
    const move = vi.fn(() => Effect.succeed(undefined))
    const service = { move } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-move-invalid',
        method: 'petOps.move',
        params: { x: 42, y: '84' }
      })
    )

    expect(move).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-move-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.focusMain to the injected provider service and publishes jump events', async () => {
    const payload = { worktreeId: 'worktree-1' }
    const events: Array<{ channel: string; payload: unknown }> = []
    const eventBus = makeEventBus()
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const focusMain = vi.fn(() => Effect.succeed(undefined))
    const service = { focusMain } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-focus-main-1',
        method: 'petOps.focusMain',
        params: payload
      })
    )

    unsubscribe()
    expect(focusMain).toHaveBeenCalledWith(payload)
    expect(events).toEqual([
      { channel: PET_JUMP_TO_WORKTREE_CHANNEL, payload: { worktreeId: 'worktree-1' } }
    ])
    expect(response).toEqual({
      id: 'pet-focus-main-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.focusMain params before calling the provider service', async () => {
    const eventBus = makeEventBus()
    const events: Array<{ channel: string; payload: unknown }> = []
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const focusMain = vi.fn(() => Effect.succeed(undefined))
    const service = { focusMain } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-focus-main-invalid',
        method: 'petOps.focusMain',
        params: { worktreeId: 123 }
      })
    )

    unsubscribe()
    expect(focusMain).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(response).toMatchObject({
      id: 'pet-focus-main-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.getConfig to the injected provider service', async () => {
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
    const getConfig = vi.fn(() => Effect.succeed(config))
    const service = { getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-get-config-1',
        method: 'petOps.getConfig',
        params: {}
      })
    )

    expect(getConfig).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-get-config-1',
      ok: true,
      value: config
    })
  })

  it('validates petOps.getConfig params before calling the provider service', async () => {
    const getConfig = vi.fn(() =>
      Effect.succeed({
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
      })
    )
    const service = { getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-get-config-invalid',
        method: 'petOps.getConfig',
        params: { includeManifest: true }
      })
    )

    expect(getConfig).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-get-config-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.getCurrentStatus to the injected provider service', async () => {
    const status = {
      state: 'working' as const,
      sourceWorktreeId: 'worktree-1',
      workingSessionCount: 1
    }
    const getCurrentStatus = vi.fn(() => Effect.succeed(status))
    const service = { getCurrentStatus } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-get-current-status-1',
        method: 'petOps.getCurrentStatus',
        params: {}
      })
    )

    expect(getCurrentStatus).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'pet-get-current-status-1',
      ok: true,
      value: status
    })
  })

  it('validates petOps.getCurrentStatus params before calling the provider service', async () => {
    const getCurrentStatus = vi.fn(() =>
      Effect.succeed({
        state: 'working' as const,
        sourceWorktreeId: 'worktree-1',
        workingSessionCount: 1
      })
    )
    const service = { getCurrentStatus } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-get-current-status-invalid',
        method: 'petOps.getCurrentStatus',
        params: { refresh: true }
      })
    )

    expect(getCurrentStatus).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'pet-get-current-status-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.updateSettings to the injected provider service and publishes settings events', async () => {
    let currentSettings = {
      enabled: false,
      petId: 'bee',
      size: 'M' as const,
      opacity: 1,
      hasHatched: false
    }
    const partial = { enabled: true, size: 'L' as const, opacity: 0.75 }
    const events: Array<{ channel: string; payload: unknown }> = []
    const eventBus = makeEventBus()
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const updateSettings = vi.fn((nextPartial: typeof partial) =>
      Effect.sync(() => {
        currentSettings = { ...currentSettings, ...nextPartial }
      })
    )
    const getConfig = vi.fn(() =>
      Effect.succeed({
        settings: currentSettings,
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
      })
    )
    const service = { updateSettings, getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-update-settings-1',
        method: 'petOps.updateSettings',
        params: partial
      })
    )

    unsubscribe()
    expect(updateSettings).toHaveBeenCalledWith(partial)
    expect(getConfig).toHaveBeenCalledWith()
    expect(events).toEqual([{ channel: PET_SETTINGS_UPDATED_CHANNEL, payload: currentSettings }])
    expect(response).toEqual({
      id: 'pet-update-settings-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.updateSettings params before calling the provider service', async () => {
    const eventBus = makeEventBus()
    const events: Array<{ channel: string; payload: unknown }> = []
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const updateSettings = vi.fn(() => Effect.succeed(undefined))
    const getConfig = vi.fn(() =>
      Effect.succeed({
        settings: {
          enabled: false,
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
      })
    )
    const service = { updateSettings, getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-update-settings-invalid',
        method: 'petOps.updateSettings',
        params: { size: 'XL' }
      })
    )

    unsubscribe()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(getConfig).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(response).toMatchObject({
      id: 'pet-update-settings-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes petOps.markHatched to the injected provider service and publishes settings events', async () => {
    let currentSettings = {
      enabled: true,
      petId: 'bee',
      size: 'M' as const,
      opacity: 1,
      hasHatched: false
    }
    const events: Array<{ channel: string; payload: unknown }> = []
    const eventBus = makeEventBus()
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const markHatched = vi.fn(() =>
      Effect.sync(() => {
        currentSettings = { ...currentSettings, hasHatched: true }
      })
    )
    const getConfig = vi.fn(() =>
      Effect.succeed({
        settings: currentSettings,
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
      })
    )
    const service = { markHatched, getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-mark-hatched-1',
        method: 'petOps.markHatched',
        params: {}
      })
    )

    unsubscribe()
    expect(markHatched).toHaveBeenCalledWith()
    expect(getConfig).toHaveBeenCalledWith()
    expect(events).toEqual([{ channel: PET_SETTINGS_UPDATED_CHANNEL, payload: currentSettings }])
    expect(response).toEqual({
      id: 'pet-mark-hatched-1',
      ok: true,
      value: undefined
    })
  })

  it('validates petOps.markHatched params before calling the provider service', async () => {
    const eventBus = makeEventBus()
    const events: Array<{ channel: string; payload: unknown }> = []
    const unsubscribe = Effect.runSync(
      eventBus.subscribeAll((event) => {
        events.push(event)
      })
    )
    const markHatched = vi.fn(() => Effect.succeed(undefined))
    const getConfig = vi.fn(() =>
      Effect.succeed({
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
      })
    )
    const service = { markHatched, getConfig } as unknown as PetOpsRpcService
    const router = makeRpcRouter({
      eventBus,
      petOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'pet-mark-hatched-invalid',
        method: 'petOps.markHatched',
        params: { hasHatched: true }
      })
    )

    unsubscribe()
    expect(markHatched).not.toHaveBeenCalled()
    expect(getConfig).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(response).toMatchObject({
      id: 'pet-mark-hatched-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
