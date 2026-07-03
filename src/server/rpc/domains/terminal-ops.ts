import { Effect } from 'effect'
import { z } from 'zod'
import type { EventBus } from '../../events/event-bus'
import { getGhosttyTerminalConfig } from '../../../main/services/ghostty-config-store'
import { createLogger } from '../../../main/services/logger'
import { ptyService } from '../../../main/services/pty-service'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type TerminalGhosttyAvailabilityResult,
  type TerminalGhosttyCreateSurfaceOptions,
  type TerminalGhosttyCreateSurfaceResult,
  type TerminalGhosttyFocusDiagnosticsResult,
  type TerminalGhosttyKeyEvent,
  type TerminalGhosttyRect,
  type TerminalGhosttyInitResult
} from '../../../shared/desktop-command'
import type { GhosttyTerminalConfig } from '../../../shared/types/terminal'
import type { RpcHandler } from '../router'

export interface TerminalOpsRpcService {
  readonly getConfig: () => Effect.Effect<GhosttyTerminalConfig, unknown, never>
  /** Force a re-read of the Ghostty config from disk (user-initiated; may touch the TCC-protected dir). */
  readonly resyncGhosttyConfig?: () => Effect.Effect<GhosttyTerminalConfig, unknown>
  readonly logDiagnostics?: (
    event: string,
    data: Record<string, unknown>
  ) => Effect.Effect<void, unknown>
  readonly create: (
    terminalId: string,
    cwd: string,
    shell?: string
  ) => Effect.Effect<TerminalCreateResult, unknown>
  readonly createClaudeCli: (
    sessionId: string,
    opts?: { pendingPrompt?: string | null }
  ) => Effect.Effect<TerminalCreateResult, unknown>
  readonly ghosttyInit: () => Effect.Effect<TerminalGhosttyInitResult, unknown>
  readonly ghosttyIsAvailable: () => Effect.Effect<TerminalGhosttyAvailabilityResult, unknown>
  readonly ghosttyCreateSurface: (
    terminalId: string,
    rect: TerminalGhosttyRect,
    opts?: TerminalGhosttyCreateSurfaceOptions
  ) => Effect.Effect<TerminalGhosttyCreateSurfaceResult, unknown>
  readonly ghosttySetFrame: (
    terminalId: string,
    rect: TerminalGhosttyRect
  ) => Effect.Effect<void, unknown>
  readonly ghosttySetSize: (
    terminalId: string,
    width: number,
    height: number
  ) => Effect.Effect<void, unknown>
  readonly ghosttyKeyEvent?: (
    terminalId: string,
    event: TerminalGhosttyKeyEvent
  ) => Effect.Effect<boolean, unknown>
  readonly ghosttyMouseButton?: (
    terminalId: string,
    state: number,
    button: number,
    mods: number
  ) => Effect.Effect<void, unknown>
  readonly ghosttyMousePos?: (
    terminalId: string,
    x: number,
    y: number,
    mods: number
  ) => Effect.Effect<void, unknown>
  readonly ghosttyMouseScroll?: (
    terminalId: string,
    dx: number,
    dy: number,
    mods: number
  ) => Effect.Effect<void, unknown>
  readonly ghosttySetFocus?: (terminalId: string, focused: boolean) => Effect.Effect<void, unknown>
  readonly ghosttyPasteText?: (terminalId: string, text: string) => Effect.Effect<void, unknown>
  readonly ghosttyFocusDiagnostics?: () => Effect.Effect<
    TerminalGhosttyFocusDiagnosticsResult,
    unknown
  >
  readonly ghosttyDestroySurface?: (terminalId: string) => Effect.Effect<void, unknown>
  readonly ghosttyShutdown?: () => Effect.Effect<void, unknown>
  readonly write: (terminalId: string, data: string) => Effect.Effect<void, unknown>
  readonly resize: (terminalId: string, cols: number, rows: number) => Effect.Effect<void, unknown>
  readonly destroy: (terminalId: string) => Effect.Effect<void, unknown>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const logDiagnosticsParamsSchema = z
  .object({
    event: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
const terminalIdParamsSchema = z
  .object({
    terminalId: z.string().min(1)
  })
  .strict()
const createParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    cwd: z.string().min(1),
    shell: z.string().optional()
  })
  .strict()
const createClaudeCliParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    opts: z
      .object({
        pendingPrompt: z.string().nullable().optional()
      })
      .optional()
  })
  .strict()
const ghosttyRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number()
  })
  .strict()
const ghosttyCreateSurfaceParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    rect: ghosttyRectSchema,
    opts: z
      .object({
        cwd: z.string().optional(),
        shell: z.string().optional(),
        scaleFactor: z.number().optional(),
        fontSize: z.number().optional(),
        shiftEnterAsNewline: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()
const ghosttySetFrameParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    rect: ghosttyRectSchema
  })
  .strict()
const ghosttySetSizeParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    width: z.number(),
    height: z.number()
  })
  .strict()
const ghosttyKeyEventSchema = z
  .object({
    action: z.number(),
    keycode: z.number(),
    mods: z.number(),
    consumedMods: z.number().optional(),
    text: z.string().optional(),
    unshiftedCodepoint: z.number().optional(),
    composing: z.boolean().optional()
  })
  .strict()
const ghosttyKeyEventParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    event: ghosttyKeyEventSchema
  })
  .strict()
const ghosttyMouseButtonParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    state: z.number(),
    button: z.number(),
    mods: z.number()
  })
  .strict()
const ghosttyMousePosParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    x: z.number(),
    y: z.number(),
    mods: z.number()
  })
  .strict()
const ghosttyMouseScrollParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    dx: z.number(),
    dy: z.number(),
    mods: z.number()
  })
  .strict()
const ghosttySetFocusParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    focused: z.boolean()
  })
  .strict()
const ghosttyPasteTextParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    text: z.string()
  })
  .strict()
const ghosttyDestroySurfaceParamsSchema = z
  .object({
    terminalId: z.string().min(1)
  })
  .strict()
const resizeParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    cols: z.number(),
    rows: z.number()
  })
  .strict()
const writeParamsSchema = z
  .object({
    terminalId: z.string().min(1),
    data: z.string()
  })
  .strict()

interface TerminalResizeResult {
  readonly success: boolean
  readonly error?: string
}

interface TerminalCreateResult {
  readonly success: boolean
  readonly cols?: number
  readonly rows?: number
  readonly error?: string
}

type TerminalDestroyResult = TerminalResizeResult
type TerminalWriteResult = TerminalResizeResult

const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()
const dataBuffers = new Map<string, string>()
const flushScheduled = new Set<string>()

const publishTerminalEvent = (
  eventBus: EventBus | undefined,
  channel: string,
  payload: unknown
): void => {
  if (!eventBus) return
  void Effect.runPromise(eventBus.publish({ channel, payload })).catch(() => undefined)
}

const detachBackendPtyListeners = (terminalId: string): void => {
  const cleanup = listenerCleanups.get(terminalId)
  if (cleanup) {
    cleanup.removeData()
    cleanup.removeExit()
    listenerCleanups.delete(terminalId)
  }
  dataBuffers.delete(terminalId)
  flushScheduled.delete(terminalId)
}

const attachBackendPtyListeners = (eventBus: EventBus | undefined, terminalId: string): void => {
  detachBackendPtyListeners(terminalId)

  const removeData = ptyService.onData(terminalId, (data) => {
    const existing = dataBuffers.get(terminalId)
    dataBuffers.set(terminalId, existing ? existing + data : data)

    if (!flushScheduled.has(terminalId)) {
      flushScheduled.add(terminalId)
      setImmediate(() => {
        flushScheduled.delete(terminalId)
        const buffered = dataBuffers.get(terminalId)
        dataBuffers.delete(terminalId)
        if (buffered) publishTerminalEvent(eventBus, `terminal:data:${terminalId}`, buffered)
      })
    }
  })

  const removeExit = ptyService.onExit(terminalId, (code) => {
    publishTerminalEvent(eventBus, `terminal:exit:${terminalId}`, code)
    detachBackendPtyListeners(terminalId)
  })

  listenerCleanups.set(terminalId, { removeData, removeExit })
}

const isTerminalCommandResult = (value: unknown): value is TerminalResizeResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('error' in value) || typeof value.error === 'string')

const isTerminalResizeResult = isTerminalCommandResult
const isTerminalDestroyResult = isTerminalCommandResult
const isTerminalWriteResult = isTerminalCommandResult
const isTerminalCreateResult = isTerminalCommandResult
const isTerminalGhosttyInitResult = (value: unknown): value is TerminalGhosttyInitResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('version' in value) || typeof value.version === 'string') &&
  (!('error' in value) || typeof value.error === 'string')
const isTerminalGhosttyAvailabilityResult = (
  value: unknown
): value is TerminalGhosttyAvailabilityResult =>
  typeof value === 'object' &&
  value !== null &&
  'available' in value &&
  typeof value.available === 'boolean' &&
  'initialized' in value &&
  typeof value.initialized === 'boolean' &&
  'platform' in value &&
  typeof value.platform === 'string'

const isTerminalGhosttyCreateSurfaceResult = (
  value: unknown
): value is TerminalGhosttyCreateSurfaceResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('surfaceId' in value) || typeof value.surfaceId === 'number') &&
  (!('error' in value) || typeof value.error === 'string')

const isTerminalGhosttyFocusDiagnosticsResult = (
  value: unknown
): value is TerminalGhosttyFocusDiagnosticsResult =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'surfaceId' in item &&
      typeof item.surfaceId === 'number' &&
      'subviewCount' in item &&
      typeof item.subviewCount === 'number' &&
      'firstResponderClass' in item &&
      typeof item.firstResponderClass === 'string' &&
      'isHostView' in item &&
      typeof item.isHostView === 'boolean' &&
      'isDescendant' in item &&
      typeof item.isDescendant === 'boolean' &&
      'hasWindow' in item &&
      typeof item.hasWindow === 'boolean'
  )

const requestDesktopTerminalGhosttyInit = (): Promise<TerminalGhosttyInitResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command transport is not available'
    })
  }

  const id = `terminal-ghostty-init-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyInit'

  return new Promise<TerminalGhosttyInitResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalGhosttyInitResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalGhosttyInitResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

const requestDesktopTerminalGhosttyCreateSurface = (
  terminalId: string,
  rect: TerminalGhosttyRect,
  opts?: TerminalGhosttyCreateSurfaceOptions
): Promise<TerminalGhosttyCreateSurfaceResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command transport is not available'
    })
  }

  const id = `terminal-ghostty-create-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyCreateSurface'

  return new Promise<TerminalGhosttyCreateSurfaceResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalGhosttyCreateSurfaceResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalGhosttyCreateSurfaceResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, rect, opts }),
      (error) => {
        if (!error) return
        finish({ success: false, error: error.message })
      }
    )
  })
}

const requestDesktopTerminalGhosttySetFrame = (
  terminalId: string,
  rect: TerminalGhosttyRect
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-set-frame-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttySetFrame'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId, rect }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestDesktopTerminalGhosttySetSize = (
  terminalId: string,
  width: number,
  height: number
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-set-size-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttySetSize'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, width, height }),
      (error) => {
        if (!error) return
        finish(error)
      }
    )
  })
}

const requestDesktopTerminalGhosttyKeyEvent = (
  terminalId: string,
  event: TerminalGhosttyKeyEvent
): Promise<boolean> => {
  const send = process.send
  if (!send) {
    return Promise.resolve(false)
  }

  const id = `terminal-ghostty-key-event-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyKeyEvent'

  return new Promise<boolean>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish(false)
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(false)
        return
      }
      if (typeof message.value === 'boolean') {
        finish(message.value)
        return
      }
      finish(false)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId, event }), (error) => {
      if (!error) return
      finish(false)
    })
  })
}

const requestDesktopTerminalGhosttyMouseButton = (
  terminalId: string,
  state: number,
  button: number,
  mods: number
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-mouse-button-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyMouseButton'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, state, button, mods }),
      (error) => {
        if (!error) return
        finish(error)
      }
    )
  })
}

const requestDesktopTerminalGhosttyMousePos = (
  terminalId: string,
  x: number,
  y: number,
  mods: number
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-mouse-pos-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyMousePos'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, x, y, mods }),
      (error) => {
        if (!error) return
        finish(error)
      }
    )
  })
}

const requestDesktopTerminalGhosttyMouseScroll = (
  terminalId: string,
  dx: number,
  dy: number,
  mods: number
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-mouse-scroll-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyMouseScroll'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, dx, dy, mods }),
      (error) => {
        if (!error) return
        finish(error)
      }
    )
  })
}

const requestDesktopTerminalGhosttySetFocus = (
  terminalId: string,
  focused: boolean
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-set-focus-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttySetFocus'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId, focused }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestDesktopTerminalGhosttyPasteText = (
  terminalId: string,
  text: string
): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-paste-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyPasteText'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId, text }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestDesktopTerminalGhosttyFocusDiagnostics =
  (): Promise<TerminalGhosttyFocusDiagnosticsResult> => {
    const send = process.send
    if (!send) {
      return Promise.resolve([])
    }

    const id = `terminal-ghostty-focus-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const command = 'terminalGhosttyFocusDiagnostics'

    return new Promise<TerminalGhosttyFocusDiagnosticsResult>((resolve) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timeout)
        process.off('message', onMessage)
      }
      const finish = (value: TerminalGhosttyFocusDiagnosticsResult): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const timeout = setTimeout(() => {
        finish([])
      }, 5_000)

      const onMessage = (message: unknown): void => {
        if (!isDesktopCommandResult(message) || message.id !== id) return
        if (!message.ok) {
          finish([])
          return
        }
        if (isTerminalGhosttyFocusDiagnosticsResult(message.value)) {
          finish(message.value)
          return
        }
        finish([])
      }

      process.on('message', onMessage)
      send.call(process, makeDesktopCommandRequest(id, command), (error) => {
        if (!error) return
        finish([])
      })
    })
  }

const requestDesktopTerminalGhosttyDestroySurface = (terminalId: string): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-destroy-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyDestroySurface'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestDesktopTerminalGhosttyShutdown = (): Promise<void> => {
  const send = process.send
  if (!send) {
    return Promise.reject(new Error('Desktop command transport is not available'))
  }

  const id = `terminal-ghostty-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyShutdown'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestDesktopTerminalGhosttyIsAvailable = (): Promise<TerminalGhosttyAvailabilityResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      available: false,
      initialized: false,
      platform: process.platform
    })
  }

  const id = `terminal-ghostty-is-available-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalGhosttyIsAvailable'

  return new Promise<TerminalGhosttyAvailabilityResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalGhosttyAvailabilityResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        available: false,
        initialized: false,
        platform: process.platform
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({
          available: false,
          initialized: false,
          platform: process.platform
        })
        return
      }
      if (isTerminalGhosttyAvailabilityResult(message.value)) {
        finish(message.value)
        return
      }
      finish({
        available: false,
        initialized: false,
        platform: process.platform
      })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish({
        available: false,
        initialized: false,
        platform: process.platform
      })
    })
  })
}

const requestDesktopTerminalCreateClaudeCli = (
  sessionId: string,
  opts?: { pendingPrompt?: string | null }
): Promise<TerminalCreateResult> => {
  const send = process.send
  if (!send) {
    return Promise.resolve({
      success: false,
      error: 'Desktop command transport is not available'
    })
  }

  const id = `terminal-create-claude-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalCreateClaudeCli'

  return new Promise<TerminalCreateResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalCreateResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalCreateResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { sessionId, opts }), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

const requestDesktopTerminalResize = (
  terminalId: string,
  cols: number,
  rows: number
): Promise<TerminalResizeResult> => {
  const send = process.send
  if (!send) return Promise.resolve({ success: true })

  const id = `terminal-resize-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalResize'

  return new Promise<TerminalResizeResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalResizeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalResizeResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { terminalId, cols, rows }),
      (error) => {
        if (!error) return
        finish({ success: false, error: error.message })
      }
    )
  })
}

const requestDesktopTerminalDestroy = (terminalId: string): Promise<TerminalDestroyResult> => {
  const send = process.send
  if (!send) return Promise.resolve({ success: true })

  const id = `terminal-destroy-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalDestroy'

  return new Promise<TerminalDestroyResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalDestroyResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalDestroyResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId }), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

const requestDesktopTerminalWrite = (
  terminalId: string,
  data: string
): Promise<TerminalWriteResult> => {
  const send = process.send
  if (!send) return Promise.resolve({ success: true })

  const id = `terminal-write-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'terminalWrite'

  return new Promise<TerminalWriteResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: TerminalWriteResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isTerminalWriteResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { terminalId, data }), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

/**
 * Persists renderer-side terminal diagnostics (font resolution, renderer
 * fallback, fitted dimensions) into the on-disk log so reports from affected
 * machines include them. See terminal-fonts.ts in the renderer.
 */
const clientDiagnosticsLog = createLogger({ component: 'TerminalClientDiagnostics' })

export const makeLiveTerminalOpsRpcService = (eventBus?: EventBus): TerminalOpsRpcService => ({
  getConfig: () =>
    Effect.sync(() => {
      try {
        return getGhosttyTerminalConfig()
      } catch {
        return {}
      }
    }),
  resyncGhosttyConfig: () =>
    Effect.sync(() => {
      try {
        return getGhosttyTerminalConfig({ refresh: true })
      } catch {
        return {}
      }
    }),
  logDiagnostics: (event, data) =>
    Effect.sync(() => {
      clientDiagnosticsLog.info(event, data)
    }),
  create: (terminalId, cwd, shell) =>
    Effect.sync(() => {
      try {
        const alreadyExists = ptyService.has(terminalId)
        const { cols, rows } = ptyService.create(terminalId, { cwd, shell: shell || undefined })

        if (!alreadyExists) {
          attachBackendPtyListeners(eventBus, terminalId)
        }

        return { success: true, cols, rows }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }),
  createClaudeCli: (sessionId, opts) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalCreateClaudeCli(sessionId, opts),
      catch: (cause) => cause
    }),
  ghosttyInit: () =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyInit(),
      catch: (cause) => cause
    }),
  ghosttyIsAvailable: () =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyIsAvailable(),
      catch: (cause) => cause
    }),
  ghosttyCreateSurface: (terminalId, rect, opts) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyCreateSurface(terminalId, rect, opts),
      catch: (cause) => cause
    }),
  ghosttySetFrame: (terminalId, rect) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttySetFrame(terminalId, rect),
      catch: (cause) => cause
    }),
  ghosttySetSize: (terminalId, width, height) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttySetSize(terminalId, width, height),
      catch: (cause) => cause
    }),
  ghosttyKeyEvent: (terminalId, event) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyKeyEvent(terminalId, event),
      catch: (cause) => cause
    }),
  ghosttyMouseButton: (terminalId, state, button, mods) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyMouseButton(terminalId, state, button, mods),
      catch: (cause) => cause
    }),
  ghosttyMousePos: (terminalId, x, y, mods) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyMousePos(terminalId, x, y, mods),
      catch: (cause) => cause
    }),
  ghosttyMouseScroll: (terminalId, dx, dy, mods) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyMouseScroll(terminalId, dx, dy, mods),
      catch: (cause) => cause
    }),
  ghosttySetFocus: (terminalId, focused) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttySetFocus(terminalId, focused),
      catch: (cause) => cause
    }),
  ghosttyPasteText: (terminalId, text) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyPasteText(terminalId, text),
      catch: (cause) => cause
    }),
  ghosttyFocusDiagnostics: () =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyFocusDiagnostics(),
      catch: (cause) => cause
    }),
  ghosttyDestroySurface: (terminalId) =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyDestroySurface(terminalId),
      catch: (cause) => cause
    }),
  ghosttyShutdown: () =>
    Effect.tryPromise({
      try: () => requestDesktopTerminalGhosttyShutdown(),
      catch: (cause) => cause
    }),
  write: (terminalId, data) =>
    Effect.tryPromise({
      try: async () => {
        if (ptyService.has(terminalId)) {
          ptyService.write(terminalId, data)
          return
        }

        const result = await requestDesktopTerminalWrite(terminalId, data)
        if (!result.success) throw new Error(result.error ?? 'Failed to write to terminal')
      },
      catch: (cause) => cause
    }),
  resize: (terminalId, cols, rows) =>
    Effect.tryPromise({
      try: async () => {
        if (ptyService.has(terminalId)) {
          ptyService.resize(terminalId, cols, rows)
          return
        }

        const result = await requestDesktopTerminalResize(terminalId, cols, rows)
        if (!result.success) throw new Error(result.error ?? 'Failed to resize terminal')
      },
      catch: (cause) => cause
    }),
  destroy: (terminalId) =>
    Effect.tryPromise({
      try: async () => {
        if (ptyService.has(terminalId)) {
          detachBackendPtyListeners(terminalId)
          ptyService.destroy(terminalId)
          return
        }

        const result = await requestDesktopTerminalDestroy(terminalId)
        if (!result.success) throw new Error(result.error ?? 'Failed to destroy terminal')
      },
      catch: (cause) => cause
    })
})

export const makeTerminalOpsRpcHandlers = (
  service: TerminalOpsRpcService = makeLiveTerminalOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'terminalOps.getConfig',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getConfig()
        })
    ],
    [
      'terminalOps.resyncGhosttyConfig',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* (service.resyncGhosttyConfig?.() ?? service.getConfig())
        })
    ],
    [
      'terminalOps.logDiagnostics',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => logDiagnosticsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* (service.logDiagnostics?.(parsed.event, parsed.data ?? {}) ??
            Effect.succeed(undefined))
        })
    ],
    [
      'terminalOps.create',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => createParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.create(parsed.terminalId, parsed.cwd, parsed.shell)
        })
    ],
    [
      'terminalOps.createClaudeCli',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => createClaudeCliParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createClaudeCli(parsed.sessionId, parsed.opts)
        })
    ],
    [
      'terminalOps.ghosttyInit',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ghosttyInit()
        })
    ],
    [
      'terminalOps.ghosttyIsAvailable',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ghosttyIsAvailable()
        })
    ],
    [
      'terminalOps.ghosttyCreateSurface',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyCreateSurfaceParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ghosttyCreateSurface(parsed.terminalId, parsed.rect, parsed.opts)
        })
    ],
    [
      'terminalOps.ghosttySetFrame',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttySetFrameParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ghosttySetFrame(parsed.terminalId, parsed.rect)
        })
    ],
    [
      'terminalOps.ghosttySetSize',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttySetSizeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ghosttySetSize(parsed.terminalId, parsed.width, parsed.height)
        })
    ],
    [
      'terminalOps.ghosttyKeyEvent',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyKeyEventParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyKeyEvent?.(parsed.terminalId, parsed.event) ?? Effect.succeed(false)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyMouseButton',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyMouseButtonParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyMouseButton?.(
              parsed.terminalId,
              parsed.state,
              parsed.button,
              parsed.mods
            ) ?? Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyMousePos',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyMousePosParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyMousePos?.(parsed.terminalId, parsed.x, parsed.y, parsed.mods) ??
            Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyMouseScroll',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyMouseScrollParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyMouseScroll?.(parsed.terminalId, parsed.dx, parsed.dy, parsed.mods) ??
            Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttySetFocus',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttySetFocusParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttySetFocus?.(parsed.terminalId, parsed.focused) ??
            Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyPasteText',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyPasteTextParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyPasteText?.(parsed.terminalId, parsed.text) ?? Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyFocusDiagnostics',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation = service.ghosttyFocusDiagnostics?.() ?? Effect.succeed([])
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyDestroySurface',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => ghosttyDestroySurfaceParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation =
            service.ghosttyDestroySurface?.(parsed.terminalId) ?? Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.ghosttyShutdown',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const operation = service.ghosttyShutdown?.() ?? Effect.succeed(undefined)
          return yield* operation
        })
    ],
    [
      'terminalOps.write',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => writeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.write(parsed.terminalId, parsed.data)
        })
    ],
    [
      'terminalOps.resize',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => resizeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.resize(parsed.terminalId, parsed.cols, parsed.rows)
        })
    ],
    [
      'terminalOps.destroy',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => terminalIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.destroy(parsed.terminalId)
        })
    ]
  ])
