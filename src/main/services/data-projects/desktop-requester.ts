// Server child → Electron main desktop commands for data projects (secrets vault, file
// dialogs), over the spawn's private `ipc` pipe: `process.send(request)` and wait for the
// DesktopCommandResult with the same id (same protocol as system-ops' requestDesktopCommand).
//
// Unlike the shared 5 s requester, the timeout is per call: the first safeStorage access can
// sit behind a macOS Keychain prompt, and a file dialog waits for the user indefinitely.
// Results are returned raw; callers validate them. Nothing here logs payloads or values.

import { isDesktopCommandResult, type DesktopCommandRequest } from '../../../shared/desktop-command'

export type DataDesktopFailureKind =
  /** No Electron main reachable (browser / Docker server, tests). */
  | 'unavailable'
  | 'timeout'
  /** Main answered with an error. */
  | 'failed'
  /** The IPC send itself failed (channel closed). */
  | 'send'

export class DataDesktopCommandError extends Error {
  readonly kind: DataDesktopFailureKind

  constructor(kind: DataDesktopFailureKind, message: string) {
    super(message)
    this.name = 'DataDesktopCommandError'
    this.kind = kind
  }
}

export interface DataDesktopCommandRequester {
  /** True when an Electron main process can answer (the server runs as the desktop child). */
  readonly available: () => boolean
  /**
   * Sends `makeRequest(id)` and resolves the result value. `timeoutMs: null` waits until main
   * answers (dialogs). Rejects with DataDesktopCommandError.
   */
  readonly request: (
    makeRequest: (id: string) => DesktopCommandRequest,
    options: { readonly timeoutMs: number | null }
  ) => Promise<unknown>
}

let sequence = 0

const nextId = (): string =>
  `data-${Date.now().toString(36)}-${(sequence++).toString(36)}-${Math.random().toString(36).slice(2)}`

/** The slice of `process` the requester uses (injectable for tests). */
export interface DesktopIpcProcess {
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

/** A requester over `proc.send` + `proc.on('message')`; `send` is read at call time. */
export const createProcessDesktopRequester = (
  proc: DesktopIpcProcess
): DataDesktopCommandRequester => ({
  available: () => typeof proc.send === 'function',
  request: (makeRequest, options) => {
    const send = proc.send
    if (typeof send !== 'function') {
      return Promise.reject(
        new DataDesktopCommandError('unavailable', 'No desktop main process is reachable')
      )
    }
    const id = nextId()
    const request = makeRequest(id)
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (error: DataDesktopCommandError | null, value?: unknown): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        proc.off('message', onMessage)
        if (error) reject(error)
        else resolve(value)
      }
      const onMessage = (message: unknown): void => {
        if (!isDesktopCommandResult(message) || message.id !== id) return
        if (message.ok) finish(null, message.value)
        else
          finish(
            new DataDesktopCommandError(
              'failed',
              message.error ?? `Desktop command failed: ${request.command}`
            )
          )
      }
      if (options.timeoutMs !== null) {
        timer = setTimeout(() => {
          finish(
            new DataDesktopCommandError(
              'timeout',
              `Timed out waiting for desktop command response: ${request.command}`
            )
          )
        }, options.timeoutMs)
        // A pending Keychain prompt must not keep a shutting-down server alive.
        timer.unref?.()
      }
      proc.on('message', onMessage)
      try {
        send.call(proc, request, (error: Error | null) => {
          if (error)
            finish(new DataDesktopCommandError('send', 'Desktop command could not be sent'))
        })
      } catch {
        finish(new DataDesktopCommandError('send', 'Desktop command could not be sent'))
      }
    })
  }
})

/** The real requester of the server child: the spawn's `ipc` pipe to Electron main. */
export const processDesktopRequester: DataDesktopCommandRequester = createProcessDesktopRequester(
  process as unknown as DesktopIpcProcess
)
