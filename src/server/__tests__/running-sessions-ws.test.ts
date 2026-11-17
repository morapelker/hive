// The window's report of its running sessions, over a real socket: the report is filed under
// the socket it came through, and is gone when that socket closes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNNING_SESSIONS_REPORT_RPC } from '../../shared/session-running-state'
import { makeEventBus } from '../events/event-bus'
import {
  makeLiveSettingsOpsRpcService,
  makeSettingsOpsRpcHandlers
} from '../rpc/domains/settings-ops'
import { makeRpcRouter } from '../rpc/router'
import { attachWebSocketRpcServer } from '../rpc/ws-server'
import { createRunningSessionsTracker } from '../running-sessions'

const servers: { server: Server; closeAll: () => void }[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const { server, closeAll } of servers.splice(0)) {
    closeAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const start = async () => {
  const tracker = createRunningSessionsTracker()
  const eventBus = makeEventBus()
  const router = makeRpcRouter(
    { eventBus },
    makeSettingsOpsRpcHandlers(makeLiveSettingsOpsRpcService({ activity: tracker }))
  )
  const server = createServer()
  const ws = attachWebSocketRpcServer(server, router, eventBus, {
    onSocketClosed: (socketId) => tracker.releaseSocket(socketId)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push({ server, closeAll: ws.closeAll })
  return { tracker, port: (server.address() as AddressInfo).port, closeAll: ws.closeAll }
}

const open = async (port: number): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true })
  })
  return socket
}

let nextId = 0
const report = (socket: WebSocket, sessionIds: string[]): Promise<unknown> => {
  const id = `report-${++nextId}`
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as { id?: string }
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      resolve(message)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method: RUNNING_SESSIONS_REPORT_RPC, params: { sessionIds } }))
  })
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort()

describe('running sessions reported over the RPC socket', () => {
  it("keeps each window's report apart and replaces it with the next one", async () => {
    const { tracker, port } = await start()
    const first = await open(port)
    const second = await open(port)

    await expect(report(first, ['s1', 's2'])).resolves.toMatchObject({
      ok: true,
      value: { ok: true }
    })
    await report(second, ['s3'])
    expect(sorted(tracker.runningSessionIds())).toEqual(['s1', 's2', 's3'])

    await report(first, ['s2'])
    expect(sorted(tracker.runningSessionIds())).toEqual(['s2', 's3'])
  })

  it("forgets a window's report when its socket closes", async () => {
    const { tracker, port } = await start()
    const first = await open(port)
    const second = await open(port)
    await report(first, ['s1'])
    await report(second, ['s2'])

    first.close()

    await vi.waitFor(() => expect(tracker.runningSessionIds()).toEqual(['s2']))
  })

  it('forgets every report when the server closes its sockets', async () => {
    const { tracker, port, closeAll } = await start()
    await report(await open(port), ['s1'])
    await report(await open(port), ['s2'])

    closeAll()

    expect(tracker.runningSessionIds()).toEqual([])
  })

  it('refuses a report that is not a list of session ids', async () => {
    const { tracker, port } = await start()
    const socket = await open(port)
    const id = 'bad-report'
    const answer = new Promise<unknown>((resolve) =>
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), {
        once: true
      })
    )
    socket.send(
      JSON.stringify({ id, method: RUNNING_SESSIONS_REPORT_RPC, params: { sessionIds: 's1' } })
    )

    await expect(answer).resolves.toMatchObject({ id, ok: false })
    expect(tracker.runningSessionIds()).toEqual([])
  })
})
