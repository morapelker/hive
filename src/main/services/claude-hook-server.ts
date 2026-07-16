import http from 'http'
import type { SessionStatusType } from '@shared/types/session-status'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { createLogger } from './logger'
import { cliHookTransportRouter } from './cli-hook-transport-router'
import { handleClaudeCliHiveTelemetryHook } from './hive-enterprise-claude-cli-telemetry'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import {
  clearAllClaudeCliInteractions,
  clearClaudeCliInteractions,
  hasBlockingClaudeCliInteraction,
  processClaudeCliHook
} from './claude-cli-interaction-ledger'
import {
  clearAllClaudeCliSubagentTracking,
  isTaskNotificationPrompt,
  processClaudeCliSubagentHook,
  setClaudeCliDeferredCompletionHandler,
  type ClaudeCliBackgroundTask
} from './claude-cli-subagent-tracker'
import {
  clearAllClaudeCliPlanAutoApprove,
  consumeClaudeCliPlanAutoApprove,
  isClaudeCliPlanAutoApproveArmed,
  setClaudeCliPlanAutoApprove
} from './claude-cli-plan-auto-approve'
// Runtime import is one-way: grok-cli-hooks only type-imports from this module.
import { translateGrokHook, type GrokHookBody } from './grok-cli-hooks'
import { ptyService } from './pty-service'

// Delay between replying to the ExitPlanMode PermissionRequest hook and
// pressing "1" on the PTY: claude renders its plan dialog only after the hook
// response lands, and the keypress must hit the dialog, not the composer.
const PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS = 500

// Approval keystroke per CLI: claude's plan dialog takes "1" ("Yes, and
// bypass permissions"); grok's plan approval view takes "a" (approve —
// always-approve is already armed underneath via the spawn args).
const PLAN_AUTO_APPROVE_KEYSTROKE: Record<CliHookProvider, string> = {
  claude: '1',
  grok: 'a'
}

type CliHookProvider = 'claude' | 'grok'

export interface ParsedClaudeHook {
  hook_event_name?: string
  tool_name?: string
  tool_use_id?: string
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
  /** Present on subagent-scoped hooks (SubagentStop, subagent-scoped Stop). */
  agent_id?: string
  agent_type?: string
  /** Snapshot of in-flight background work at Stop/SubagentStop time. */
  background_tasks?: ClaudeCliBackgroundTask[]
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
    taskNotification?: boolean
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
      SubagentStop: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'subagent') }]
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
    case 'SubagentStop':
      return null
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

  if (hook.hook_event_name === 'UserPromptSubmit' && isTaskNotificationPrompt(hook.prompt)) {
    metadata.taskNotification = true
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
  void Promise.resolve(publishDesktopBackendEvent('claude-cli:status', payload)).catch(
    () => undefined
  )
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

function parseHookPath(
  url: string | undefined
): { sessionId: string; hookPath: string; provider: CliHookProvider } | null {
  if (!url) return null

  try {
    const parsed = new URL(url, `http://${host}`)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 3) return null
    const provider: CliHookProvider | null =
      segments[0] === 'hook' ? 'claude' : segments[0] === 'grok-hook' ? 'grok' : null
    if (!provider) return null

    return {
      sessionId: decodeURIComponent(segments[1]),
      hookPath: segments[2],
      provider
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
    const parsedBody: unknown = JSON.parse(rawBody || '{}')
    // Grok payloads (camelCase, snake_case events, grok tool names) are
    // translated into the claude hook shape so the rest of this pipeline is
    // provider-agnostic. A null translation means the event is noise for the
    // pipeline (child-session lifecycle, non-permission notifications).
    const body =
      route?.provider === 'grok'
        ? translateGrokHook(route.sessionId, parsedBody as GrokHookBody)
        : (parsedBody as ParsedClaudeHook)
    if (route && body) {
      const status = mapHookEventToStatus(body)
      const mapped: ClaudeCliStatusPayload | null = status
        ? {
            sessionId: route.sessionId,
            status,
            metadata: buildStatusMetadata(body, route.hookPath)
          }
        : null
      // Background Task subagents can keep running after the main agent's
      // Stop fires; the tracker decides whether this Stop is truly final
      // ('pass'), must be swallowed because work is still in flight
      // ('defer_stop'), or is scoped to a subagent turn and never a session
      // completion ('subagent_scoped'). Only a 'pass' should reach the
      // ledger/telemetry/status publish — a deferred Stop's RESET would
      // otherwise clobber a subagent's latched question/permission.
      const gate = processClaudeCliSubagentHook(route.sessionId, body, mapped)
      if (gate.kind === 'pass') {
        // The interaction ledger latches blocking statuses (question/permission/
        // plan approval) so parallel sub-agent hooks can't clobber them, and
        // re-surfaces queued interactions as each one resolves.
        for (const payload of processClaudeCliHook(route.sessionId, body, mapped)) {
          publishClaudeCliStatus(payload)
        }
        // Telemetry parses claude-format transcript JSONL; grok's
        // updates.jsonl has a different schema, so grok sessions skip it.
        if (route.provider === 'claude') {
          void handleClaudeCliHiveTelemetryHook(route.sessionId, body)
        }
      }
      // First user prompt of this CLI session → tell the renderer so it can
      // auto-create a kanban ticket (if the setting is on). Fires for prompts
      // typed straight into the terminal as well as composer/handoff prompts.
      // A task-notification resume is an auto-generated continuation turn,
      // not a user-authored prompt, so it must never count as "first prompt"
      // (and must not be recorded as announced — a later real prompt should
      // still announce).
      if (
        body.hook_event_name === 'UserPromptSubmit' &&
        typeof body.prompt === 'string' &&
        body.prompt.trim().length > 0 &&
        !isTaskNotificationPrompt(body.prompt) &&
        !firstPromptAnnounced.has(route.sessionId)
      ) {
        firstPromptAnnounced.add(route.sessionId)
        void publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
          type: 'claude-cli.first-prompt-detected',
          sessionId: route.sessionId,
          data: { promptText: body.prompt }
        })
      }
      // Plan auto-approve: an armed session's ExitPlanMode is answered here
      // instead of by the user. The setMode permission is only honored on the
      // PermissionRequest hook (not PreToolUse), so the PreToolUse must fall
      // through unheld — which also means transports (Telegram/Discord) must
      // not grab it, or the plan would go to the phone instead. Subagent
      // ExitPlanMode hooks (agent_id set) never consume the main plan's arm.
      //
      // Grok has no PermissionRequest hook and its plan-approval view opens
      // right after exit_plan_mode starts executing, so the keystroke is
      // scheduled off the PreToolUse instead (a synthesized PermissionRequest
      // from a permission notification is accepted too; the one-shot consume
      // makes whichever fires first win).
      const autoApproveExitPlan =
        body.tool_name === 'ExitPlanMode' &&
        !body.agent_id &&
        isClaudeCliPlanAutoApproveArmed(route.sessionId)
      const autoApproveTriggerEvent =
        route.provider === 'grok'
          ? body.hook_event_name === 'PreToolUse' || body.hook_event_name === 'PermissionRequest'
          : body.hook_event_name === 'PermissionRequest'
      const bypassTransport =
        autoApproveExitPlan &&
        (body.hook_event_name === 'PreToolUse' || body.hook_event_name === 'PermissionRequest')

      // For forwarded CLI sessions a transport may take ownership of the
      // response (held open until answered). Otherwise behavior is unchanged.
      // suppressIdle keeps a deferred/subagent-scoped Stop from telling the
      // transport the session went idle while background work is in flight.
      if (!bypassTransport) {
        owned = cliHookTransportRouter.routeHook(route.sessionId, body, res, {
          suppressIdle: gate.kind !== 'pass'
        })
      }

      if (autoApproveExitPlan && autoApproveTriggerEvent && !res.writableEnded) {
        // Hook responses cannot approve the plan dialog: on claude v2.1.201 a
        // PermissionRequest hookSpecificOutput.decision (allow + setMode) is
        // accepted but the interactive dialog is shown anyway (verified
        // empirically — claude-playground keeps a keystroke fallback for the
        // same reason). So reply '{}' to let the dialog render, then press "1"
        // ("Yes, and bypass permissions") on the PTY — approval and
        // bypassPermissions in the same stroke, exactly like a manual approve.
        // Grok's approval view takes "a" instead; always-approve is already
        // armed underneath from the spawn args.
        const approvedSessionId = route.sessionId
        const keystroke = PLAN_AUTO_APPROVE_KEYSTROKE[route.provider]
        consumeClaudeCliPlanAutoApprove(approvedSessionId)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        setTimeout(() => {
          if (!ptyService.has(approvedSessionId)) {
            log.warn('Plan auto-approve keystroke skipped: PTY is gone', {
              sessionId: approvedSessionId
            })
            return
          }
          ptyService.write(approvedSessionId, keystroke)
          log.info('Auto-approved ExitPlanMode plan', { sessionId: approvedSessionId })
        }, PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS)
      }

      if (body.hook_event_name === 'SessionEnd') {
        setClaudeCliPlanAutoApprove(route.sessionId, false)
      }
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
  // Re-registered on every call (the setter is idempotent) because
  // closeClaudeHookServer clears it — a subsequent getClaudeHookServer() must
  // restore it even when reusing an already-listening server.
  setClaudeCliDeferredCompletionHandler((sessionId, payload, lastAssistantMessage) => {
    if (hasBlockingClaudeCliInteraction(sessionId)) return false
    clearClaudeCliInteractions(sessionId)
    // Intentionally does not record telemetry idle here (no recordIdle call):
    // this path fires when the resume turn's own Stop never showed up, so
    // there is no matching hook payload to drive recordIdle off of. Known
    // accepted gap: this can leave a dangling `activePromptBySession` entry
    // in the telemetry module, which would inflate the *next* turn's usage
    // delta with this turn's untallied tokens.
    publishClaudeCliStatus({
      ...payload,
      metadata: { ...payload.metadata, reason: 'deferred_completion_watchdog' }
    })
    cliHookTransportRouter.notifySessionIdle(sessionId, lastAssistantMessage)
    return true
  })

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
    clearAllClaudeCliInteractions()
    clearAllClaudeCliSubagentTracking()
    clearAllClaudeCliPlanAutoApprove()
    setClaudeCliDeferredCompletionHandler(null)
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
  clearAllClaudeCliInteractions()
  clearAllClaudeCliSubagentTracking()
  clearAllClaudeCliPlanAutoApprove()
  setClaudeCliDeferredCompletionHandler(null)
}
