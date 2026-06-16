import http from 'http'
import type { SessionStatusType } from '@shared/types/session-status'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { createLogger } from './logger'
import { cliHookTransportRouter } from './cli-hook-transport-router'
import { handleClaudeCliHiveTelemetryHook } from './hive-enterprise-claude-cli-telemetry'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export interface ParsedClaudeHook {
  hook_event_name?: string
  tool_name?: string
  permission_mode?: string
  prompt?: unknown
  transcript_path?: unknown
  tool_input?: {
    plan?: unknown
    questions?: unknown
  }
  /** Final assistant message of the turn (Stop hook). Read both spellings: */
  assistant_message?: string
  last_assistant_message?: string
}

export interface ClaudeCliStatusPayload {
  sessionId: string
  status: SessionStatusType
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
const lastStatusBySession = new Map<string, SessionStatusType>()
const statusSubscribers = new Set<(payload: ClaudeCliStatusPayload) => void>()
// Sessions whose first UserPromptSubmit we've already announced (so the
// "automatically create ticket" feature fires at most once per session). The
// renderer's getBySession idempotency check is the real guard; this just keeps
// us from re-emitting on every prompt.
const firstPromptAnnounced = new Set<string>()

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
          // A generous timeout (default is 600s) so a question/plan held open
          // while a human answers via Telegram isn't cancelled early. Harmless
          // when not held — it's a ceiling, not a delay.
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool'), timeout: 600 }]
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

export function mapHookEventToStatus(hook: ParsedClaudeHook): SessionStatusType | null {
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

export function publishClaudeCliStatus(payload: ClaudeCliStatusPayload): void {
  if (lastStatusBySession.get(payload.sessionId) === payload.status) {
    return
  }

  lastStatusBySession.set(payload.sessionId, payload.status)
  for (const subscriber of statusSubscribers) {
    subscriber(payload)
  }
  void import('../desktop/backend-event-publisher')
    .then(({ publishDesktopBackendEvent }) =>
      publishDesktopBackendEvent('claude-cli:status', payload)
    )
    .catch(() => undefined)
}

/**
 * Read the most recently published live status for a Claude CLI session, or
 * undefined if none has been published in this process. Used to gate actions
 * (e.g. teleport) on whether the session is actively running vs idle/stopped.
 */
export function getLastClaudeCliStatus(sessionId: string): SessionStatusType | undefined {
  return lastStatusBySession.get(sessionId)
}

/**
 * Drop a session's last-published status. Call from the PTY exit / destroy
 * teardown paths so the dedup map does not grow for the lifetime of the app and
 * a session re-created with the same id starts with fresh dedup state (otherwise
 * a stale 'completed' would swallow the restarted session's first status).
 */
export function clearClaudeCliStatus(sessionId: string): void {
  lastStatusBySession.delete(sessionId)
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

  // Read+parse the body before responding so the Telegram bridge can decide
  // whether to hold the response open (to answer a question/plan remotely). The
  // status publish below is unchanged and still drives the in-app badge.
  const route = parseHookPath(req.url)
  let owned = false
  try {
    const rawBody = await readRequestBody(req)
    const body = JSON.parse(rawBody || '{}') as ParsedClaudeHook
    if (route) {
      const status = mapHookEventToStatus(body)
      if (status) {
        publishClaudeCliStatus({
          sessionId: route.sessionId,
          status,
          metadata: buildStatusMetadata(body, route.hookPath)
        })
      }
      void handleClaudeCliHiveTelemetryHook(route.sessionId, body)
      // First user prompt of this CLI session → tell the renderer so it can
      // auto-create a kanban ticket (if the setting is on). Fires for prompts
      // typed straight into the terminal as well as composer/handoff prompts.
      if (
        body.hook_event_name === 'UserPromptSubmit' &&
        typeof body.prompt === 'string' &&
        body.prompt.trim().length > 0 &&
        !firstPromptAnnounced.has(route.sessionId)
      ) {
        firstPromptAnnounced.add(route.sessionId)
        void publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
          type: 'claude-cli.first-prompt-detected',
          sessionId: route.sessionId,
          data: { promptText: body.prompt }
        })
      }
      // For forwarded CLI sessions a transport may take ownership of the
      // response (held open until answered). Otherwise behavior is unchanged.
      owned = cliHookTransportRouter.routeHook(route.sessionId, body, res)
    }
  } catch (error) {
    log.warn('Failed to parse Claude hook payload', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (!owned && !res.writableEnded) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }
}

export async function getClaudeHookServer(): Promise<{ port: number }> {
  if (server && boundPort !== null) {
    return { port: boundPort }
  }

  if (startingPromise) {
    return startingPromise
  }

  server = http.createServer((req, res) => {
    void handleHook(req, res)
  })

  // Held hook responses (a question/plan awaiting a Telegram answer) can stay
  // open for minutes; disable Node's own request/socket timeouts so they aren't
  // dropped mid-wait. The per-hook `timeout` in the injected settings is the
  // real upper bound, with the bridge's safety timer just under it.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0

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
  // Unblock any held hook responses first, otherwise their open sockets keep the
  // server alive and `close()` hangs at shutdown.
  cliHookTransportRouter.cancelAll()

  if (!server) {
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
  boundPort = null
  startingPromise = null
  lastStatusBySession.clear()
  statusSubscribers.clear()
}
