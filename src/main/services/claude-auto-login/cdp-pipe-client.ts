/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Chrome launched with that flag reads CDP requests from its fd 3 and writes
 * responses/events to fd 4, each message a JSON object terminated by `\0`. No
 * WebSocket, no debugging port to discover, and nothing another process on the
 * machine could connect to — which is why it is preferred over
 * `--remote-debugging-port` for driving a sign-in that handles credentials.
 *
 * Only what the sign-in driver needs: request/response correlation by `id`,
 * per-session routing (`sessionId` from `Target.attachToTarget` with
 * `flatten: true`) and an event stream. Deliberately avoids `Runtime.enable`:
 * its side effects are a well-known automation tell, and `Runtime.evaluate`
 * works without it.
 */
import type { Readable, Writable } from 'stream'

export interface CdpError extends Error {
  code?: number
}

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
}

export class CdpPipeClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private buffer = ''
  private closed = false
  private readonly closeListeners = new Set<() => void>()

  constructor(
    private readonly writable: Writable,
    readable: Readable
  ) {
    readable.setEncoding('utf8')
    readable.on('data', (chunk: string) => this.onData(chunk))
    const onClose = (): void => this.handleClose()
    readable.on('close', onClose)
    readable.on('end', onClose)
    readable.on('error', onClose)
    writable.on('error', onClose)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Fires once, when the pipe goes away (Chrome exited or was killed). */
  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP pipe closed (${method})`))
    const id = this.nextId++
    const message = JSON.stringify(
      sessionId ? { id, method, params, sessionId } : { id, method, params }
    )
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method })
      this.writable.write(message + '\0', (error) => {
        if (error) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  /** Stops listening; the caller owns the Chrome process and closes it separately. */
  close(): void {
    this.handleClose()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let end = this.buffer.indexOf('\0')
    while (end !== -1) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (raw.length > 0) this.dispatch(raw)
      end = this.buffer.indexOf('\0')
    }
  }

  private dispatch(raw: string): void {
    let message: {
      id?: number
      result?: unknown
      error?: { code?: number; message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return // a torn frame — nothing we can correlate
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        const error: CdpError = new Error(
          `${pending.method}: ${message.error.message ?? 'CDP error'}`
        )
        error.code = message.error.code
        pending.reject(error)
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }

    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId
      }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          // a listener's bug must not take the transport down
        }
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('CDP pipe closed')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const listener of this.closeListeners) {
      try {
        listener()
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear()
    this.listeners.clear()
  }
}
