import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Socket, connect } from 'node:net'
import { once } from 'node:events'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import { attachWebSocketRpcServer } from '../rpc/ws-server'
import type { RpcRouter } from '../rpc/router'

interface TestServer {
  readonly server: Server
  readonly port: number
  readonly closeAll: () => void
}

interface ServerFrame {
  readonly opcode: number
  readonly payload: Buffer
}

class TestWebSocketClient {
  private buffer = Buffer.alloc(0)

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
    })
  }

  write(frame: Buffer): void {
    this.socket.write(frame)
  }

  async readFrame(timeoutMs = 2000): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const parsed = parseServerFrame(this.buffer)
      if (parsed) {
        this.buffer = parsed.remaining
        return { opcode: parsed.opcode, payload: parsed.payload }
      }

      const remaining = deadline - Date.now()
      await Promise.race([
        once(this.socket, 'data'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for WebSocket frame')), remaining)
        )
      ])
    }

    throw new Error('Timed out waiting for WebSocket frame')
  }

  async readJson(timeoutMs = 2000): Promise<unknown> {
    const frame = await this.readFrame(timeoutMs)
    return JSON.parse(frame.payload.toString('utf8'))
  }

  destroy(): void {
    this.socket.destroy()
  }
}

const openServers: TestServer[] = []
const openClients: TestWebSocketClient[] = []

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.destroy()
  }

  for (const testServer of openServers.splice(0)) {
    testServer.closeAll()
    await new Promise<void>((resolve, reject) => {
      testServer.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

describe('WebSocket frame fragmentation', () => {
  it('handles an RPC request fragmented across continuation frames', async () => {
    const testServer = await startEchoServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const text = 'x'.repeat(200_000)
    const request = { id: 'frag-1', method: 'test.echo', params: { text } }
    const payload = Buffer.from(JSON.stringify(request))

    const splitAt = 131_072
    client.write(createClientFrame(payload.subarray(0, splitAt), { opcode: 0x1, fin: false }))
    client.write(createClientFrame(payload.subarray(splitAt), { opcode: 0x0, fin: true }))

    const response = await client.readJson()
    expect(response).toEqual({ id: 'frag-1', ok: true, value: { textLength: text.length } })
  })

  it('handles a large single frame using the 64-bit payload length', async () => {
    const testServer = await startEchoServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const text = 'y'.repeat(200_000)
    const request = { id: 'large-1', method: 'test.echo', params: { text } }
    client.write(createClientFrame(Buffer.from(JSON.stringify(request)), { opcode: 0x1, fin: true }))

    const response = await client.readJson()
    expect(response).toEqual({ id: 'large-1', ok: true, value: { textLength: text.length } })
  })

  it('handles a ping interleaved between fragments', async () => {
    const testServer = await startEchoServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const text = 'z'.repeat(150_000)
    const request = { id: 'frag-ping-1', method: 'test.echo', params: { text } }
    const payload = Buffer.from(JSON.stringify(request))

    const splitAt = 100_000
    client.write(createClientFrame(payload.subarray(0, splitAt), { opcode: 0x1, fin: false }))
    client.write(createClientFrame(Buffer.from('ping'), { opcode: 0x9, fin: true }))
    client.write(createClientFrame(payload.subarray(splitAt), { opcode: 0x0, fin: true }))

    const pong = await client.readFrame()
    expect(pong.opcode).toBe(0xa)
    expect(pong.payload.toString('utf8')).toBe('ping')

    const response = await client.readJson()
    expect(response).toEqual({ id: 'frag-ping-1', ok: true, value: { textLength: text.length } })
  })

  it('still handles multiple small unfragmented requests', async () => {
    const testServer = await startEchoServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    for (const id of ['small-1', 'small-2']) {
      const request = { id, method: 'test.echo', params: { text: 'hello' } }
      client.write(
        createClientFrame(Buffer.from(JSON.stringify(request)), { opcode: 0x1, fin: true })
      )
      const response = await client.readJson()
      expect(response).toEqual({ id, ok: true, value: { textLength: 5 } })
    }
  })
})

const startEchoServer = async (): Promise<TestServer> => {
  const server = createServer()
  const eventBus = makeEventBus()
  const router: RpcRouter = {
    handle: (request) => {
      const { id, params } = request as { id?: string; params?: { text?: string } }
      return Effect.succeed({
        id: id ?? '',
        ok: true,
        value: { textLength: params?.text?.length ?? 0 }
      })
    }
  }
  const webSocketServer = attachWebSocketRpcServer(server, router, eventBus)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing test server address')

  const testServer = { server, port: address.port, closeAll: webSocketServer.closeAll }
  openServers.push(testServer)
  return testServer
}

const connectClient = async (port: number): Promise<TestWebSocketClient> => {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')

  const key = randomBytes(16).toString('base64')
  socket.write(
    [
      'GET /ws HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '\r\n'
    ].join('\r\n')
  )

  await readHandshake(socket)
  return new TestWebSocketClient(socket)
}

const readHandshake = async (socket: Socket): Promise<void> => {
  let buffer = Buffer.alloc(0)
  while (!buffer.includes('\r\n\r\n')) {
    const [chunk] = (await once(socket, 'data')) as [Buffer]
    buffer = Buffer.concat([buffer, chunk])
  }
  expect(buffer.toString('utf8')).toContain('101 Switching Protocols')
}

const createClientFrame = (
  payload: Buffer,
  { opcode, fin }: { opcode: number; fin: boolean }
): Buffer => {
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | payload.length
  } else if (payload.length <= 65535) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode

  const mask = randomBytes(4)
  const maskedPayload = Buffer.from(payload)
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4]
  }

  return Buffer.concat([header, mask, maskedPayload])
}

const parseServerFrame = (
  buffer: Buffer
): { readonly opcode: number; readonly payload: Buffer; readonly remaining: Buffer } | null => {
  if (buffer.length < 2) return null

  const opcode = buffer[0] & 0x0f
  let length = buffer[1] & 0x7f
  let headerLength = 2

  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    headerLength = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const longLength = buffer.readBigUInt64BE(2)
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Frame too large')
    }
    length = Number(longLength)
    headerLength = 10
  }

  const frameEnd = headerLength + length
  if (buffer.length < frameEnd) return null

  return {
    opcode,
    payload: Buffer.from(buffer.subarray(headerLength, frameEnd)),
    remaining: Buffer.from(buffer.subarray(frameEnd))
  }
}
