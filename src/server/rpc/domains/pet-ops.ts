import { Effect } from 'effect'
import { z } from 'zod'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type FocusMainFromPetPayload,
  type GetCurrentPetStatusResult,
  type GetPetConfigResult,
  type MovePetPayload,
  type PublishPetStatusPayload,
  type SetPetIgnoreMousePayload,
  type UpdatePetSettingsPayload
} from '../../../shared/desktop-command'
import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '../../../shared/pet-events'
import type { PetPosition, PetSettings, PetStatusPayload } from '../../../shared/types/pet'
import type { RpcContext, RpcHandler } from '../router'

export interface PetOpsRpcService {
  readonly show: () => Effect.Effect<void, unknown, never>
  readonly hide: () => Effect.Effect<void, unknown, never>
  readonly publishStatus: (payload: PetStatusPayload) => Effect.Effect<void, unknown, never>
  readonly setIgnoreMouse: (ignore: boolean) => Effect.Effect<void, unknown, never>
  readonly beginPointerInteraction: () => Effect.Effect<void, unknown, never>
  readonly endPointerInteraction?: () => Effect.Effect<void, unknown, never>
  readonly move?: (position: PetPosition) => Effect.Effect<void, unknown, never>
  readonly focusMain?: (payload: FocusMainFromPetPayload) => Effect.Effect<void, unknown, never>
  readonly getConfig?: () => Effect.Effect<GetPetConfigResult, unknown, never>
  readonly getCurrentStatus?: () => Effect.Effect<GetCurrentPetStatusResult, unknown, never>
  readonly updateSettings?: (partial: Partial<PetSettings>) => Effect.Effect<void, unknown, never>
  readonly markHatched?: () => Effect.Effect<void, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const petStatusParamsSchema = z
  .object({
    state: z.enum(['idle', 'working', 'question', 'permission', 'plan_ready']),
    sourceWorktreeId: z.string().nullable(),
    workingSessionCount: z.number().int().nonnegative()
  })
  .strict()
const setIgnoreMouseParamsSchema = z.object({ ignore: z.boolean() }).strict()
const moveParamsSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
const focusMainParamsSchema = z.object({ worktreeId: z.string().nullable() }).strict()
const updateSettingsParamsSchema = z
  .object({
    enabled: z.boolean().optional(),
    petId: z.string().optional(),
    size: z.enum(['S', 'M', 'L']).optional(),
    opacity: z.number().finite().optional(),
    animationSpeedEnabled: z.boolean().optional(),
    animationSpeed: z.number().finite().optional(),
    hasHatched: z.boolean().optional()
  })
  .strict()

const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  petId: 'bee',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: false
}

let fallbackPetSettings: PetSettings = { ...DEFAULT_PET_SETTINGS }

const applyFallbackPetSettings = (partial: Partial<PetSettings>): void => {
  fallbackPetSettings = { ...fallbackPetSettings, ...partial }
}

const makeDefaultPetConfigResult = (): GetPetConfigResult => ({
  settings: { ...fallbackPetSettings },
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

const makeDefaultPetStatusResult = (): GetCurrentPetStatusResult => ({
  state: 'idle',
  sourceWorktreeId: null,
  workingSessionCount: 0
})

export const makeLivePetOpsRpcService = (): PetOpsRpcService => ({
  show: () =>
    Effect.tryPromise({
      try: () => requestPetCommand('showPet').then(() => undefined),
      catch: (cause) => cause
    }),
  hide: () =>
    Effect.tryPromise({
      try: () => requestPetCommand('hidePet').then(() => undefined),
      catch: (cause) => cause
    }),
  publishStatus: (payload) =>
    Effect.tryPromise({
      try: () => requestPublishPetStatusCommand(payload).then(() => undefined),
      catch: (cause) => cause
    }),
  setIgnoreMouse: (ignore) =>
    Effect.tryPromise({
      try: () => requestSetPetIgnoreMouseCommand({ ignore }).then(() => undefined),
      catch: (cause) => cause
    }),
  beginPointerInteraction: () =>
    Effect.tryPromise({
      try: () => requestPetCommand('beginPetPointerInteraction').then(() => undefined),
      catch: (cause) => cause
    }),
  endPointerInteraction: () =>
    Effect.tryPromise({
      try: () => requestPetCommand('endPetPointerInteraction').then(() => undefined),
      catch: (cause) => cause
    }),
  move: (position) =>
    Effect.tryPromise({
      try: () => requestMovePetCommand(position).then(() => undefined),
      catch: (cause) => cause
    }),
  focusMain: (payload) =>
    Effect.tryPromise({
      try: () => requestFocusMainFromPetCommand(payload).then(() => undefined),
      catch: (cause) => cause
    }),
  getConfig: () =>
    Effect.tryPromise({
      try: () => requestGetPetConfigCommand(),
      catch: (cause) => cause
    }),
  getCurrentStatus: () =>
    Effect.tryPromise({
      try: () => requestGetCurrentPetStatusCommand(),
      catch: (cause) => cause
    }),
  updateSettings: (partial) =>
    Effect.tryPromise({
      try: () => requestUpdatePetSettingsCommand(partial).then(() => undefined),
      catch: (cause) => cause
    }),
  markHatched: () =>
    Effect.tryPromise({
      try: () => requestMarkPetHatchedCommand().then(() => undefined),
      catch: (cause) => cause
    })
})

export const makePetOpsRpcHandlers = (
  service: PetOpsRpcService = makeLivePetOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'petOps.show',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.show()
        })
    ],
    [
      'petOps.hide',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.hide()
        })
    ],
    [
      'petOps.publishStatus',
      (params, context) =>
        Effect.gen(function* () {
          const payload = yield* Effect.try({
            try: () => petStatusParamsSchema.parse(params),
            catch: (cause) => cause
          })
          yield* service.publishStatus(payload)
          yield* context.eventBus.publish({ channel: PET_STATUS_CHANNEL, payload })
        })
    ],
    [
      'petOps.setIgnoreMouse',
      (params) =>
        Effect.gen(function* () {
          const { ignore } = yield* Effect.try({
            try: () => setIgnoreMouseParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setIgnoreMouse(ignore)
        })
    ],
    [
      'petOps.beginPointerInteraction',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.beginPointerInteraction()
        })
    ],
    [
      'petOps.endPointerInteraction',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.endPointerInteraction) {
            return yield* Effect.fail(new Error('petOps.endPointerInteraction is unavailable'))
          }
          return yield* service.endPointerInteraction()
        })
    ],
    [
      'petOps.move',
      (params) =>
        Effect.gen(function* () {
          const position = yield* Effect.try({
            try: () => moveParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.move) {
            return yield* Effect.fail(new Error('petOps.move is unavailable'))
          }
          return yield* service.move(position)
        })
    ],
    [
      'petOps.focusMain',
      (params, context) =>
        Effect.gen(function* () {
          const payload = yield* Effect.try({
            try: () => focusMainParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.focusMain) {
            return yield* Effect.fail(new Error('petOps.focusMain is unavailable'))
          }
          yield* service.focusMain(payload)
          if (payload.worktreeId) {
            yield* context.eventBus.publish({
              channel: PET_JUMP_TO_WORKTREE_CHANNEL,
              payload: { worktreeId: payload.worktreeId }
            })
          }
        })
    ],
    [
      'petOps.getConfig',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getConfig) {
            return yield* Effect.fail(new Error('petOps.getConfig is unavailable'))
          }
          return yield* service.getConfig()
        })
    ],
    [
      'petOps.getCurrentStatus',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getCurrentStatus) {
            return yield* Effect.fail(new Error('petOps.getCurrentStatus is unavailable'))
          }
          return yield* service.getCurrentStatus()
        })
    ],
    [
      'petOps.updateSettings',
      (params, context) =>
        Effect.gen(function* () {
          const partial = yield* Effect.try({
            try: () => updateSettingsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.updateSettings) {
            return yield* Effect.fail(new Error('petOps.updateSettings is unavailable'))
          }
          yield* service.updateSettings(partial)
          yield* publishPetSettingsUpdatedEvent(service, context)
        })
    ],
    [
      'petOps.markHatched',
      (params, context) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.markHatched) {
            return yield* Effect.fail(new Error('petOps.markHatched is unavailable'))
          }
          yield* service.markHatched()
          yield* publishPetSettingsUpdatedEvent(service, context)
        })
    ]
  ])

const publishPetSettingsUpdatedEvent = (
  service: PetOpsRpcService,
  context: RpcContext
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    if (!service.getConfig) return
    const config = yield* service.getConfig()
    yield* context.eventBus.publish({
      channel: PET_SETTINGS_UPDATED_CHANNEL,
      payload: config.settings
    })
  })

const requestPetCommand = (
  command: 'showPet' | 'hidePet' | 'beginPetPointerInteraction' | 'endPetPointerInteraction'
): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    if (command === 'showPet') return Promise.resolve()
    if (command === 'hidePet') return Promise.resolve()
    if (command === 'beginPetPointerInteraction') return Promise.resolve()
    if (command === 'endPetPointerInteraction') return Promise.resolve()
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    const request = (() => {
      if (command === 'showPet') return makeDesktopCommandRequest(id, 'showPet')
      if (command === 'beginPetPointerInteraction') {
        return makeDesktopCommandRequest(id, 'beginPetPointerInteraction')
      }
      if (command === 'endPetPointerInteraction') {
        return makeDesktopCommandRequest(id, 'endPetPointerInteraction')
      }
      return makeDesktopCommandRequest(id, 'hidePet')
    })()
    send.call(process, request, (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestPublishPetStatusCommand = (payload: PublishPetStatusPayload): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const command = 'publishPetStatus'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestSetPetIgnoreMouseCommand = (payload: SetPetIgnoreMousePayload): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const command = 'setPetIgnoreMouse'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestMovePetCommand = (payload: MovePetPayload): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const command = 'movePet'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestFocusMainFromPetCommand = (payload: FocusMainFromPetPayload): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const command = 'focusMainFromPet'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestGetPetConfigCommand = (): Promise<GetPetConfigResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(makeDefaultPetConfigResult())
  }

  const command = 'getPetConfig'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<GetPetConfigResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve(message.value as GetPetConfigResult)
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestGetCurrentPetStatusCommand = (): Promise<GetCurrentPetStatusResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(makeDefaultPetStatusResult())
  }

  const command = 'getCurrentPetStatus'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<GetCurrentPetStatusResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve(message.value as GetCurrentPetStatusResult)
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestUpdatePetSettingsCommand = (payload: UpdatePetSettingsPayload): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    applyFallbackPetSettings(payload)
    return Promise.resolve()
  }

  const command = 'updatePetSettings'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestMarkPetHatchedCommand = (): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    applyFallbackPetSettings({ hasHatched: true })
    return Promise.resolve()
  }

  const command = 'markPetHatched'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}
