import { createHash } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Effect } from 'effect'
import {
  WebSocketSubscribeMessageSchema,
  WebSocketUnsubscribeMessageSchema,
  type ServerEvent
} from '@shared/rpc/protocol'
import type { RpcRouter } from './router'
import type { EventBus } from '../events/event-bus'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface WebSocketRpcServer {
  readonly closeAll: () => void
}

interface WebSocketRpcServerOptions {
  readonly path?: string
  readonly authenticateToken?: (token: string) => boolean
}

export const attachWebSocketRpcServer = (
  server: Server,
  router: RpcRouter,
  eventBus: EventBus,
  options: string | WebSocketRpcServerOptions = {}
): WebSocketRpcServer => {
  const path = typeof options === 'string' ? options : (options.path ?? '/ws')
  const authenticateToken = typeof options === 'string' ? undefined : options.authenticateToken
  const sockets = new Map<Duplex, () => void>()

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== path || !isWebSocketUpgrade(request)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    if (authenticateToken) {
      const token = url.searchParams.get('token')
      if (!token || !authenticateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
    }

    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createAcceptKey(key)}`,
        '\r\n'
      ].join('\r\n')
    )

    const subscriptions = new Map<string, () => void>()
    const cleanupSocket = () => {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe()
      }
      subscriptions.clear()
      sockets.delete(socket)
    }

    sockets.set(socket, cleanupSocket)
    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const parsed = parseFrames(buffered)
      buffered = parsed.remaining

      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(createFrame(Buffer.alloc(0), 0x8))
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(createFrame(frame.payload, 0xa))
          continue
        }
        if (frame.opcode !== 0x1) continue

        let request: unknown
        try {
          request = JSON.parse(frame.payload.toString('utf8'))
        } catch (error) {
          request = {
            id: '',
            method: '',
            params: {
              parseError: error instanceof Error ? error.message : String(error)
            }
          }
        }

        if (handleSubscriptionMessage(request, socket, subscriptions, eventBus)) {
          continue
        }

        void Effect.runPromise(router.handle(request)).then(
          (response) => {
            if (!socket.destroyed) socket.write(createFrame(JSON.stringify(response), 0x1))
          },
          (error) => {
            if (!socket.destroyed) {
              socket.write(
                createFrame(
                  JSON.stringify({
                    id: '',
                    ok: false,
                    error: {
                      code: 'INTERNAL_ERROR',
                      message: error instanceof Error ? error.message : 'Unexpected RPC failure'
                    }
                  }),
                  0x1
                )
              )
            }
          }
        )
      }
    })

    socket.on('close', cleanupSocket)
    socket.on('error', cleanupSocket)
  })

  return {
    closeAll: () => {
      for (const [socket, cleanupSocket] of sockets) {
        cleanupSocket()
        socket.destroy()
      }
      sockets.clear()
    }
  }
}

const handleSubscriptionMessage = (
  request: unknown,
  socket: Duplex,
  subscriptions: Map<string, () => void>,
  eventBus: EventBus
): boolean => {
  const subscribe = WebSocketSubscribeMessageSchema.safeParse(request)
  if (subscribe.success) {
    const { channel } = subscribe.data
    if (!subscriptions.has(channel)) {
      const unsubscribe = Effect.runSync(
        eventBus.subscribe(channel, (event) => {
          sendServerEvent(socket, event)
        })
      )
      subscriptions.set(channel, unsubscribe)
    }
    return true
  }

  const unsubscribe = WebSocketUnsubscribeMessageSchema.safeParse(request)
  if (unsubscribe.success) {
    subscriptions.get(unsubscribe.data.channel)?.()
    subscriptions.delete(unsubscribe.data.channel)
    return true
  }

  return false
}

const sendServerEvent = (socket: Duplex, event: ServerEvent): void => {
  if (!socket.destroyed) {
    socket.write(createFrame(JSON.stringify(event), 0x1))
  }
}

const isWebSocketUpgrade = (request: IncomingMessage): boolean =>
  request.headers.upgrade?.toLowerCase() === 'websocket'

const createAcceptKey = (key: string): string =>
  createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')

interface ParsedFrame {
  readonly opcode: number
  readonly payload: Buffer
}

const parseFrames = (buffer: Buffer): { frames: ParsedFrame[]; remaining: Buffer } => {
  const frames: ParsedFrame[] = []
  let offset = 0

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let headerLength = 2

    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      const longLength = buffer.readBigUInt64BE(offset + 2)
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) break
      length = Number(longLength)
      headerLength = 10
    }

    const maskLength = masked ? 4 : 0
    const frameEnd = offset + headerLength + maskLength + length
    if (frameEnd > buffer.length) break

    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null
    const payloadStart = offset + headerLength + maskLength
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length))

    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4]
      }
    }

    frames.push({ opcode, payload })
    offset = frameEnd
  }

  return { frames, remaining: buffer.subarray(offset) }
}

const createFrame = (payload: string | Buffer, opcode: number): Buffer => {
  const payloadBuffer = typeof payload === 'string' ? Buffer.from(payload) : payload
  const headerLength = payloadBuffer.length < 126 ? 2 : payloadBuffer.length <= 65535 ? 4 : 10
  const header = Buffer.alloc(headerLength)
  header[0] = 0x80 | opcode

  if (payloadBuffer.length < 126) {
    header[1] = payloadBuffer.length
  } else if (payloadBuffer.length <= 65535) {
    header[1] = 126
    header.writeUInt16BE(payloadBuffer.length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2)
  }

  return Buffer.concat([header, payloadBuffer])
}
