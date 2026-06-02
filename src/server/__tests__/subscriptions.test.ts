import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Socket, connect } from 'node:net'
import { once } from 'node:events'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { makeEventBus, type EventBus } from '../events/event-bus'
import { attachWebSocketRpcServer } from '../rpc/ws-server'
import type { RpcRouter } from '../rpc/router'
import type { ServerEvent } from '../../shared/rpc/protocol'
import { WINDOW_FOCUSED_CHANNEL } from '../../shared/app-events'
import { BASH_STREAM_CHANNEL } from '../../shared/bash-events'
import { EDIT_PASTE_CHANNEL } from '../../shared/edit-events'
import { FILE_TREE_CHANGE_CHANNEL } from '../../shared/file-tree-events'
import { GIT_BRANCH_CHANGED_CHANNEL, GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'
import { NOTIFICATION_NAVIGATE_CHANNEL } from '../../shared/notification-events'
import { OPENCODE_STREAM_CHANNEL } from '../../shared/opencode-events'
import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '../../shared/pet-events'
import { SETTINGS_UPDATED_CHANNEL } from '../../shared/settings-events'
import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL
} from '../../shared/telegram-events'
import {
  UPDATER_AVAILABLE_CHANNEL,
  UPDATER_CHECKING_CHANNEL,
  UPDATER_DOWNLOADED_CHANNEL,
  UPDATER_ERROR_CHANNEL,
  UPDATER_NOT_AVAILABLE_CHANNEL,
  UPDATER_PROGRESS_CHANNEL
} from '../../shared/updater-events'
import {
  CLOSE_SESSION_SHORTCUT_CHANNEL,
  FILE_SEARCH_SHORTCUT_CHANNEL,
  NEW_SESSION_SHORTCUT_CHANNEL,
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '../../shared/shortcut-events'
import { WORKTREE_BRANCH_RENAMED_CHANNEL } from '../../shared/worktree-events'

interface TestServer {
  readonly server: Server
  readonly eventBus: EventBus
  readonly port: number
  readonly closeAll: () => void
}

class TestWebSocketClient {
  private buffer = Buffer.alloc(0)

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
    })
  }

  async send(value: unknown): Promise<void> {
    this.socket.write(createClientFrame(JSON.stringify(value)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  async readEvent(timeoutMs = 200): Promise<ServerEvent> {
    const payload = await this.readFrame(timeoutMs)
    return JSON.parse(payload.toString('utf8')) as ServerEvent
  }

  destroy(): void {
    this.socket.destroy()
  }

  private async readFrame(timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const parsed = parseServerFrame(this.buffer)
      if (parsed) {
        this.buffer = parsed.remaining
        return parsed.payload
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

describe('WebSocket subscriptions', () => {
  it('uses explicit subscription requests to deliver channel events', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await Effect.runPromise(
      testServer.eventBus.publish({
        channel: 'git:statusChanged',
        payload: { sequence: 'before-subscribe' }
      })
    )

    await client.send({ type: 'subscribe', channel: 'git:statusChanged' })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: 'git:statusChanged',
      payload: { sequence: 'after-subscribe' }
    })

    expect(event).toEqual({
      channel: 'git:statusChanged',
      payload: { sequence: 'after-subscribe' }
    })
  })

  it('delivers git status changed events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = { worktreePath: '/tmp/hive' }
    await client.send({ type: 'subscribe', channel: GIT_STATUS_CHANGED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: GIT_STATUS_CHANGED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: GIT_STATUS_CHANGED_CHANNEL,
      payload
    })
  })

  it('stops delivering channel events after unsubscribe', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: 'git:branchChanged' })
    await publishUntilReceived(testServer.eventBus, client, {
      channel: 'git:branchChanged',
      payload: { sequence: 'subscribed' }
    })

    await client.send({ type: 'unsubscribe', channel: 'git:branchChanged' })
    await client.send({ type: 'subscribe', channel: 'test:unsubscribe-barrier' })
    await publishUntilReceived(testServer.eventBus, client, {
      channel: 'test:unsubscribe-barrier',
      payload: { ready: true }
    })

    await Effect.runPromise(
      testServer.eventBus.publish({
        channel: 'git:branchChanged',
        payload: { sequence: 'after-unsubscribe' }
      })
    )
    await client.send({ type: 'subscribe', channel: 'git:branchChanged' })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: 'git:branchChanged',
      payload: { sequence: 'resubscribed' }
    })

    expect(event).toEqual({
      channel: 'git:branchChanged',
      payload: { sequence: 'resubscribed' }
    })
  })

  it('delivers git branch changed events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = { worktreePath: '/tmp/hive' }
    await client.send({ type: 'subscribe', channel: GIT_BRANCH_CHANGED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: GIT_BRANCH_CHANGED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: GIT_BRANCH_CHANGED_CHANNEL,
      payload
    })
  })

  it('delivers new-session shortcut events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: NEW_SESSION_SHORTCUT_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: NEW_SESSION_SHORTCUT_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: NEW_SESSION_SHORTCUT_CHANNEL,
      payload: {}
    })
  })

  it('delivers close-session shortcut events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: CLOSE_SESSION_SHORTCUT_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: CLOSE_SESSION_SHORTCUT_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: CLOSE_SESSION_SHORTCUT_CHANNEL,
      payload: {}
    })
  })

  it('delivers file-search shortcut events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: FILE_SEARCH_SHORTCUT_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: FILE_SEARCH_SHORTCUT_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: FILE_SEARCH_SHORTCUT_CHANNEL,
      payload: {}
    })
  })

  it('delivers quit-confirmation-show events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: QUIT_CONFIRMATION_SHOW_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: QUIT_CONFIRMATION_SHOW_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: QUIT_CONFIRMATION_SHOW_CHANNEL,
      payload: {}
    })
  })

  it('delivers quit-confirmation-hide events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: QUIT_CONFIRMATION_HIDE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: QUIT_CONFIRMATION_HIDE_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: QUIT_CONFIRMATION_HIDE_CHANNEL,
      payload: {}
    })
  })

  it('delivers edit-paste events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: EDIT_PASTE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: EDIT_PASTE_CHANNEL,
      payload: 'clipboard text'
    })

    expect(event).toEqual({
      channel: EDIT_PASTE_CHANNEL,
      payload: 'clipboard text'
    })
  })

  it('delivers notification navigation events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    }

    await client.send({ type: 'subscribe', channel: NOTIFICATION_NAVIGATE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: NOTIFICATION_NAVIGATE_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: NOTIFICATION_NAVIGATE_CHANNEL,
      payload
    })
  })

  it('delivers window-focused events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: WINDOW_FOCUSED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: WINDOW_FOCUSED_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: WINDOW_FOCUSED_CHANNEL,
      payload: {}
    })
  })

  it('delivers pet jump-to-worktree events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = { worktreeId: 'worktree-1' }
    await client.send({ type: 'subscribe', channel: PET_JUMP_TO_WORKTREE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: PET_JUMP_TO_WORKTREE_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: PET_JUMP_TO_WORKTREE_CHANNEL,
      payload
    })
  })

  it('delivers pet status events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      state: 'working',
      sourceWorktreeId: 'worktree-1'
    }
    await client.send({ type: 'subscribe', channel: PET_STATUS_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: PET_STATUS_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: PET_STATUS_CHANNEL,
      payload
    })
  })

  it('delivers pet settings updated events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      enabled: true,
      petId: 'bee',
      size: 'L',
      opacity: 0.75,
      hasHatched: true
    }
    await client.send({ type: 'subscribe', channel: PET_SETTINGS_UPDATED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: PET_SETTINGS_UPDATED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: PET_SETTINGS_UPDATED_CHANNEL,
      payload
    })
  })

  it('delivers settings updated events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      commandFilter: {
        enabled: true,
        pattern: 'pnpm test'
      }
    }
    await client.send({ type: 'subscribe', channel: SETTINGS_UPDATED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: SETTINGS_UPDATED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: SETTINGS_UPDATED_CHANNEL,
      payload
    })
  })

  it('delivers worktree branch renamed events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      worktreeId: 'worktree-1',
      newBranch: 'feature-renamed'
    }
    await client.send({ type: 'subscribe', channel: WORKTREE_BRANCH_RENAMED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload
    })
  })

  it('delivers updater checking events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    await client.send({ type: 'subscribe', channel: UPDATER_CHECKING_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_CHECKING_CHANNEL,
      payload: {}
    })

    expect(event).toEqual({
      channel: UPDATER_CHECKING_CHANNEL,
      payload: {}
    })
  })

  it('delivers updater available events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      version: '1.2.3',
      releaseNotes: 'Bug fixes',
      releaseDate: '2026-05-31T10:00:00.000Z',
      isManualCheck: true
    }
    await client.send({ type: 'subscribe', channel: UPDATER_AVAILABLE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_AVAILABLE_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: UPDATER_AVAILABLE_CHANNEL,
      payload
    })
  })

  it('delivers updater not-available events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      version: '1.2.3',
      isManualCheck: true
    }
    await client.send({ type: 'subscribe', channel: UPDATER_NOT_AVAILABLE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_NOT_AVAILABLE_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: UPDATER_NOT_AVAILABLE_CHANNEL,
      payload
    })
  })

  it('delivers updater progress events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      percent: 42.5,
      bytesPerSecond: 4096,
      transferred: 8192,
      total: 19275
    }
    await client.send({ type: 'subscribe', channel: UPDATER_PROGRESS_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_PROGRESS_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: UPDATER_PROGRESS_CHANNEL,
      payload
    })
  })

  it('delivers updater downloaded events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      version: '1.2.4',
      releaseNotes: [
        { type: 'feature', note: 'Install prompt update' },
        { type: 'fix', note: 'Downloader retry handling' }
      ]
    }
    await client.send({ type: 'subscribe', channel: UPDATER_DOWNLOADED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_DOWNLOADED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: UPDATER_DOWNLOADED_CHANNEL,
      payload
    })
  })

  it('delivers updater error events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      message: 'Update check failed',
      isManualCheck: true
    }
    await client.send({ type: 'subscribe', channel: UPDATER_ERROR_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: UPDATER_ERROR_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: UPDATER_ERROR_CHANNEL,
      payload
    })
  })

  it('delivers menu action events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)
    const channel = 'menu:new-worktree'

    await client.send({ type: 'subscribe', channel })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel,
      payload: {}
    })

    expect(event).toEqual({
      channel,
      payload: {}
    })
  })

  it('delivers bash stream events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      type: 'output',
      sessionId: 'session-1',
      runId: 'run-1',
      data: 'hello from bash'
    }

    await client.send({ type: 'subscribe', channel: BASH_STREAM_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: BASH_STREAM_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: BASH_STREAM_CHANNEL,
      payload
    })
  })

  it('delivers terminal data events over dynamic subscribed WebSocket channels', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const channel = 'terminal:data:terminal-1'

    await client.send({ type: 'subscribe', channel })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel,
      payload: 'hello from pty'
    })

    expect(event).toEqual({
      channel,
      payload: 'hello from pty'
    })
  })

  it('delivers terminal exit events over dynamic subscribed WebSocket channels', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const channel = 'terminal:exit:terminal-1'

    await client.send({ type: 'subscribe', channel })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel,
      payload: 130
    })

    expect(event).toEqual({
      channel,
      payload: 130
    })
  })

  it('delivers script output events over dynamic subscribed WebSocket channels', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const channel = 'script:run:worktree-1'
    const payload = { type: 'output', data: 'hello from script' }

    await client.send({ type: 'subscribe', channel })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel,
      payload
    })

    expect(event).toEqual({
      channel,
      payload
    })
  })

  it('delivers telegram status changed events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      active: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'questions',
      health: 'ok',
      lastError: null
    }

    await client.send({ type: 'subscribe', channel: TELEGRAM_STATUS_CHANGED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: TELEGRAM_STATUS_CHANGED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: TELEGRAM_STATUS_CHANGED_CHANNEL,
      payload
    })
  })

  it('delivers telegram plan implement requested events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      requestId: 'telegram:request:42',
      plan: '1. Update tests\n2. Implement the migration'
    }

    await client.send({ type: 'subscribe', channel: TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      payload
    })
  })

  it('delivers file tree change events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      worktreePath: '/tmp/hive',
      events: [
        {
          eventType: 'change',
          changedPath: '/tmp/hive/src/index.ts',
          relativePath: 'src/index.ts'
        },
        {
          eventType: 'unlink',
          changedPath: '/tmp/hive/src/old.ts',
          relativePath: 'src/old.ts'
        }
      ]
    }

    await client.send({ type: 'subscribe', channel: FILE_TREE_CHANGE_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: FILE_TREE_CHANGE_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: FILE_TREE_CHANGE_CHANNEL,
      payload
    })
  })

  it('delivers OpenCode stream events over the subscribed WebSocket channel', async () => {
    const testServer = await startTestServer()
    const client = await connectClient(testServer.port)
    openClients.push(client)

    const payload = {
      type: 'session.updated',
      sessionId: 'session-1',
      childSessionId: 'child-session-1',
      statusPayload: {
        type: 'busy',
        message: 'Running task'
      },
      data: {
        title: 'Implement HTTP migration',
        tokens: {
          input: 1200,
          output: 340
        }
      }
    }

    await client.send({ type: 'subscribe', channel: OPENCODE_STREAM_CHANNEL })
    const event = await publishUntilReceived(testServer.eventBus, client, {
      channel: OPENCODE_STREAM_CHANNEL,
      payload
    })

    expect(event).toEqual({
      channel: OPENCODE_STREAM_CHANNEL,
      payload
    })
  })
})

const startTestServer = async (): Promise<TestServer> => {
  const server = createServer()
  const eventBus = makeEventBus()
  const router: RpcRouter = {
    handle: () =>
      Effect.succeed({
        id: '',
        ok: false,
        error: { code: 'TEST_ROUTER', message: 'Unexpected RPC request' }
      })
  }
  const webSocketServer = attachWebSocketRpcServer(server, router, eventBus)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing test server address')

  const testServer = {
    server,
    eventBus,
    port: address.port,
    closeAll: webSocketServer.closeAll
  }
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

const publishUntilReceived = async (
  eventBus: EventBus,
  client: TestWebSocketClient,
  event: ServerEvent
): Promise<ServerEvent> => {
  let lastError: unknown

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Effect.runPromise(eventBus.publish(event))
    try {
      return await client.readEvent(100)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for event')
}

const createClientFrame = (payload: string): Buffer => {
  const payloadBuffer = Buffer.from(payload)
  if (payloadBuffer.length >= 126) throw new Error('Test client only supports short frames')

  const mask = randomBytes(4)
  const header = Buffer.from([0x81, 0x80 | payloadBuffer.length])
  const maskedPayload = Buffer.from(payloadBuffer)

  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4]
  }

  return Buffer.concat([header, mask, maskedPayload])
}

const parseServerFrame = (
  buffer: Buffer
): { readonly payload: Buffer; readonly remaining: Buffer } | null => {
  if (buffer.length < 2) return null

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
    payload: Buffer.from(buffer.subarray(headerLength, frameEnd)),
    remaining: buffer.subarray(frameEnd)
  }
}
