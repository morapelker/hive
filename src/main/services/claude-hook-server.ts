import type { BrowserWindow } from 'electron'
import http from 'http'
import { createLogger } from './logger'

export type ClaudeCliSessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'command_approval'
  | 'unread'
  | 'completed'
  | 'plan_ready'

export interface ParsedClaudeHook {
  hook_event_name?: string
  tool_name?: string
  permission_mode?: string
  tool_input?: {
    plan?: unknown
  }
}

export interface ClaudeCliStatusPayload {
  sessionId: string
  status: ClaudeCliSessionStatusType
  metadata?: {
    reason?: string
    hookEventName?: string
    hookPath?: string
    toolName?: string
    plan?: string
  }
}

const log = createLogger({ component: 'ClaudeHookServer' })
const host = '127.0.0.1'
let server: http.Server | null = null
let boundPort: number | null = null
let startingPromise: Promise<{ port: number }> | null = null
let rendererWindow: BrowserWindow | null = null
const lastStatusBySession = new Map<string, ClaudeCliSessionStatusType>()
const statusSubscribers = new Set<(payload: ClaudeCliStatusPayload) => void>()

function hookUrl(port: number, hiveSessionId: string, path: string): string {
  return `http://${host}:${port}/hook/${encodeURIComponent(hiveSessionId)}/${path}`
}

export function buildClaudeCliHookSettings(port: number, hiveSessionId: string): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'session') }]
        }
      ],
      SessionEnd: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'session') }]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'start') }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'stop') }]
        }
      ],
      PreToolUse: [
        {
          matcher: 'ExitPlanMode|AskUserQuestion',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool') }]
        }
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool') }]
        }
      ],
      PostToolUseFailure: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool') }]
        }
      ],
      PermissionRequest: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'permission') }]
        }
      ]
    }
  })
}

export function mapHookEventToStatus(hook: ParsedClaudeHook): ClaudeCliSessionStatusType | null {
  switch (hook.hook_event_name) {
    case 'SessionStart':
    case 'SessionEnd':
    case 'Stop':
      return 'completed'
    case 'UserPromptSubmit':
      return hook.permission_mode === 'plan' ? 'planning' : 'working'
    case 'PreToolUse':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      if (hook.tool_name === 'AskUserQuestion') return 'answering'
      return null
    case 'PostToolUseFailure':
      if (hook.tool_name === 'ExitPlanMode') return 'planning'
      return 'working'
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      if (hook.tool_name === 'AskUserQuestion') return 'answering'
      return 'permission'
    default:
      return null
  }
}

function extractPlanText(hook: ParsedClaudeHook): string | undefined {
  return typeof hook.tool_input?.plan === 'string' ? hook.tool_input.plan : undefined
}

function buildStatusMetadata(
  hook: ParsedClaudeHook,
  hookPath: string
): NonNullable<ClaudeCliStatusPayload['metadata']> {
  const metadata: NonNullable<ClaudeCliStatusPayload['metadata']> = {
    hookEventName: hook.hook_event_name,
    hookPath
  }

  if (hook.tool_name) {
    metadata.toolName = hook.tool_name
  }

  const plan = extractPlanText(hook)
  if (plan !== undefined) {
    metadata.plan = plan
  }

  return metadata
}

export function publishClaudeCliStatus(
  mainWindow: BrowserWindow,
  payload: ClaudeCliStatusPayload
): void {
  if (lastStatusBySession.get(payload.sessionId) === payload.status) {
    return
  }

  lastStatusBySession.set(payload.sessionId, payload.status)
  for (const subscriber of statusSubscribers) {
    subscriber(payload)
  }
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-cli:status', payload)
  }
}

export function subscribeClaudeCliStatus(
  subscriber: (payload: ClaudeCliStatusPayload) => void
): () => void {
  statusSubscribers.add(subscriber)
  return () => {
    statusSubscribers.delete(subscriber)
  }
}

function parseHookPath(url: string | undefined): { sessionId: string; hookPath: string } | null {
  if (!url) return null

  try {
    const parsed = new URL(url, `http://${host}`)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 3 || segments[0] !== 'hook') return null

    return {
      sessionId: decodeURIComponent(segments[1]),
      hookPath: segments[2]
    }
  } catch {
    return null
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''

    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const remoteAddress = req.socket.remoteAddress
  if (remoteAddress !== host) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')

  const route = parseHookPath(req.url)
  if (!route) {
    return
  }

  try {
    const rawBody = await readRequestBody(req)
    const body = JSON.parse(rawBody || '{}') as ParsedClaudeHook
    const status = mapHookEventToStatus(body)
    if (!status || !rendererWindow) {
      return
    }

    publishClaudeCliStatus(rendererWindow, {
      sessionId: route.sessionId,
      status,
      metadata: buildStatusMetadata(body, route.hookPath)
    })
  } catch (error) {
    log.warn('Failed to parse Claude hook payload', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function getClaudeHookServer(mainWindow: BrowserWindow): Promise<{ port: number }> {
  rendererWindow = mainWindow

  if (server && boundPort !== null) {
    return { port: boundPort }
  }

  if (startingPromise) {
    return startingPromise
  }

  server = http.createServer((req, res) => {
    void handleHook(req, res)
  })

  startingPromise = (async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server?.off('error', onError)
        resolve()
      }

      server?.once('error', onError)
      server?.once('listening', onListening)
      server?.listen(0, host)
    })

    const address = server?.address()
    if (!address || typeof address === 'string') {
      throw new Error('Claude hook server failed to bind a TCP port')
    }

    boundPort = address.port
    log.info(`ClaudeHookServer listening on http://${host}:${boundPort}`)
    return { port: boundPort }
  })()

  try {
    return await startingPromise
  } catch (error) {
    server = null
    boundPort = null
    throw error
  } finally {
    startingPromise = null
  }
}

export async function closeClaudeHookServer(): Promise<void> {
  if (!server) {
    rendererWindow = null
    boundPort = null
    startingPromise = null
    lastStatusBySession.clear()
    statusSubscribers.clear()
    return
  }

  const closingServer = server
  server = null

  await new Promise<void>((resolve, reject) => {
    closingServer.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })

  log.info('ClaudeHookServer closed')
  rendererWindow = null
  boundPort = null
  startingPromise = null
  lastStatusBySession.clear()
  statusSubscribers.clear()
}
