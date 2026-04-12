import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'

import { createLogger } from './logger'
import { logCodexMessage, logCodexLifecycleEvent, resetSession } from './codex-debug-logger'
import { asObject, asString, toJsonSnapshot } from './codex-utils'
import { CODEX_DEFAULT_MODEL } from './codex-models'
import { getDatabase } from '../db'
import { getUserEnvironmentVariables } from './env-vars'
import type { CommandExecutionApprovalDecision } from '@shared/codex-schemas/v2/CommandExecutionApprovalDecision'
import type { FileChangeApprovalDecision } from '@shared/codex-schemas/v2/FileChangeApprovalDecision'
import type { ThreadStartParams } from '@shared/codex-schemas/v2/ThreadStartParams'
import type { ThreadStartResponse } from '@shared/codex-schemas/v2/ThreadStartResponse'
import type { ThreadResumeResponse } from '@shared/codex-schemas/v2/ThreadResumeResponse'
import type { TurnStartResponse } from '@shared/codex-schemas/v2/TurnStartResponse'
import type { TurnInterruptParams } from '@shared/codex-schemas/v2/TurnInterruptParams'
import type { ThreadReadParams } from '@shared/codex-schemas/v2/ThreadReadParams'
import type { ThreadRollbackParams } from '@shared/codex-schemas/v2/ThreadRollbackParams'
import type { SandboxMode } from '@shared/codex-schemas/v2/SandboxMode'
import type { AskForApproval } from '@shared/codex-schemas/v2/AskForApproval'
import type { TurnStartedNotification } from '@shared/codex-schemas/v2/TurnStartedNotification'
import type { TurnCompletedNotification } from '@shared/codex-schemas/v2/TurnCompletedNotification'
import type { CommandExecutionRequestApprovalParams } from '@shared/codex-schemas/v2/CommandExecutionRequestApprovalParams'
import type { FileChangeRequestApprovalParams } from '@shared/codex-schemas/v2/FileChangeRequestApprovalParams'
import type { ToolRequestUserInputParams } from '@shared/codex-schemas/v2/ToolRequestUserInputParams'
import type { ToolRequestUserInputAnswer } from '@shared/codex-schemas/v2/ToolRequestUserInputAnswer'
import type { ServerNotification } from '@shared/codex-schemas/ServerNotification'
import type { ServerRequest } from '@shared/codex-schemas/ServerRequest'
import type { ThreadResumeParams } from '@shared/codex-schemas/v2/ThreadResumeParams'

const log = createLogger({ component: 'CodexAppServerManager' })

// ── JSON-RPC protocol types ───────────────────────────────────────

export interface JsonRpcError {
  code?: number
  message?: string
}

export interface JsonRpcRequest {
  id: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  id: string | number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

// ── Pending request tracking ──────────────────────────────────────

export interface PendingRequest {
  method: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface PendingApprovalRequest {
  requestId: string
  jsonRpcId: string | number
  method: string
  threadId: string
  turnId?: string
  itemId?: string
  payload?: unknown
}

export interface PendingUserInputRequest {
  requestId: string
  jsonRpcId: string | number
  threadId: string
  turnId?: string
  itemId?: string
}

// ── Session types ─────────────────────────────────────────────────

export type CodexProviderStatus = 'connecting' | 'ready' | 'running' | 'error' | 'closed'

export interface CodexProviderSession {
  provider: 'codex'
  status: CodexProviderStatus
  threadId: string | null
  cwd: string
  model: string | null
  activeTurnId: string | null
  resumeCursor: string | null
  createdAt: string
  updatedAt: string
  error?: string
}

export interface CodexSessionContext {
  session: CodexProviderSession
  child: ChildProcess
  output: readline.Interface
  pending: Map<string, PendingRequest>
  pendingApprovals: Map<string, PendingApprovalRequest>
  pendingUserInputs: Map<string, PendingUserInputRequest>
  collabReceiverTurns: Map<string, string> // childThreadId → parentTurnId
  nextRequestId: number
  stopping: boolean
}

// ── Start session input ───────────────────────────────────────────

export interface CodexStartSessionOptions {
  cwd: string
  model?: string
  resumeThreadId?: string
  resumeCursor?: string
  codexBinaryPath?: string
  codexHomePath?: string
}

// ── Turn input ────────────────────────────────────────────────────

export interface CodexTurnInput {
  text?: string
  input?: Array<{ type: string; text: string }>
  model?: string
  reasoningEffort?: string
  serviceTier?: string | null
  interactionMode?: 'default' | 'plan'
  developerInstructions?: string
}

export interface CodexTurnStartResult {
  turnId: string
  threadId: string
  resumeCursor?: string
}

// ── Event types ───────────────────────────────────────────────────

export interface CodexManagerEvent {
  id: string
  kind: 'session' | 'notification' | 'request' | 'error'
  provider: 'codex'
  threadId: string
  createdAt: string
  method: string
  message?: string
  turnId?: string
  itemId?: string
  requestId?: string
  textDelta?: string
  payload?: unknown
  childThreadId?: string
}

export interface CodexAppServerManagerEvents {
  event: [event: CodexManagerEvent]
}

// ── Constants ─────────────────────────────────────────────────────

const ANSI_ESCAPE_CHAR = String.fromCharCode(27)
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, 'g')
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/
const BENIGN_ERROR_LOG_SNIPPETS = [
  'state db missing rollout path for thread',
  'state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back'
]
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  'not found',
  'missing thread',
  'no such thread',
  'unknown thread',
  'does not exist'
]

function getDefaultCodexRuntimeConfig(): {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
} {
  return {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access'
  }
}

const CODEX_DEFAULT_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are operating in **default** (autonomous execution) mode. This mode is set by developer instructions and does **not** change based on user requests or conversational intent.

**IMPORTANT:** The \`request_user_input\` tool is **UNAVAILABLE** in this session mode.

- Do NOT attempt to call \`request_user_input\`
- Make reasonable assumptions and proceed autonomously
- If something is ambiguous, pick the most sensible interpretation and execute
- Prefer action over asking for clarification
- Do not stop to ask questions — make decisions and implement
</collaboration_mode>`

const CODEX_PLAN_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Plan

You are operating in **plan** mode. Plan Mode is not changed by user intent — it is set exclusively via developer instructions.

## Non-Mutating vs Mutating Actions

**Allowed (non-mutating):**
- Reading files, exploring directories, searching the codebase
- Running read-only shell commands (e.g. \`ls\`, \`grep\`, \`cat\`, \`git log\`, \`git diff\`)
- Using \`request_user_input\` to ask clarifying questions

**FORBIDDEN (mutating) — do NOT perform these actions:**
- Writing, editing, or deleting files
- Running shell commands that modify state (e.g. \`npm install\`, \`git commit\`, \`rm\`)
- Creating new files or directories
- Any other action that changes the codebase or environment

## Three-Phase Workflow

### Phase 1: Ground in the Environment
Before anything else, explore the relevant parts of the codebase:
- Read relevant files, understand conventions, identify constraints and patterns
- Use shell commands to understand project structure

### Phase 2: Intent Chat
Clarify WHAT to build:
- Use \`request_user_input\` to ask clarifying questions ONE at a time
- Confirm you understand the requirements before proceeding

### Phase 3: Finalize the Plan
When you have sufficient clarity, produce your implementation plan:
- Wrap it in a \`<proposed_plan>\` XML block
- The plan should be complete and actionable — a developer could implement it without asking further questions
- Do NOT ask "should I proceed?" or similar — producing the \`<proposed_plan>\` block IS the signal that you are done

## \`request_user_input\` Usage

- Use it to ask ONE focused question at a time
- Do NOT ask multiple questions in a single call
- Only ask what you genuinely need to know to finalize the plan

## Finalization Rules

When you have enough information:
1. Output your plan wrapped in \`<proposed_plan>\`...\`</proposed_plan>\` tags
2. The content inside should be markdown describing the implementation steps in detail
3. Stop after producing the plan block — do not implement anything
</collaboration_mode>`

// ── Stderr classification ─────────────────────────────────────────

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, '').trim()
  if (!line) {
    return null
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX)
  if (match) {
    const level = match[1]
    if (level && level !== 'ERROR') {
      return null
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))
    if (isBenignError) {
      return null
    }
  }

  return { message: line }
}

// ── Recoverable resume error check ───────────────────────────────

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (!message.includes('thread/resume')) {
    return false
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet))
}

// ── Type guards ───────────────────────────────────────────────────

export function isServerRequest(value: unknown): value is ServerRequest {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.method === 'string' &&
    (typeof candidate.id === 'string' || typeof candidate.id === 'number')
  )
}

export function isServerNotification(value: unknown): value is ServerNotification {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.method === 'string' && !('id' in candidate)
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  const hasId = typeof candidate.id === 'string' || typeof candidate.id === 'number'
  const hasMethod = typeof candidate.method === 'string'
  return hasId && !hasMethod
}

// ── Kill helper ───────────────────────────────────────────────────

export function killChildTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      // fallback to direct kill
    }
  }
  child.kill()
}

// ── User input answer format ──────────────────────────────────────
// Uses generated ToolRequestUserInputAnswer from codex-schemas

// ── Approval decision mapping ────────────────────────────────────

export type HiveApprovalDecision = 'once' | 'always' | 'reject'

function toCodexCommandApprovalDecision(
  decision: HiveApprovalDecision
): CommandExecutionApprovalDecision {
  switch (decision) {
    case 'once':
      return 'accept'
    case 'always':
      return 'acceptForSession'
    case 'reject':
      return 'decline'
  }
}

function toCodexFileChangeApprovalDecision(
  decision: HiveApprovalDecision
): FileChangeApprovalDecision {
  switch (decision) {
    case 'once':
      return 'accept'
    case 'always':
      return 'acceptForSession'
    case 'reject':
      return 'decline'
  }
}

// ── Manager class ─────────────────────────────────────────────────

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<string, CodexSessionContext>()

  // ── Public API ────────────────────────────────────────────────

  async startSession(options: CodexStartSessionOptions): Promise<CodexProviderSession> {
    const now = new Date().toISOString()
    const resolvedCwd = options.cwd || process.cwd()
    let context: CodexSessionContext | undefined

    try {
      const session: CodexProviderSession = {
        provider: 'codex',
        status: 'connecting',
        threadId: null,
        cwd: resolvedCwd,
        model: options.model ?? null,
        activeTurnId: null,
        resumeCursor: null,
        createdAt: now,
        updatedAt: now
      }

      const codexBinaryPath = options.codexBinaryPath ?? 'codex'
      const child = spawn(codexBinaryPath, ['app-server'], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...getUserEnvironmentVariables(getDatabase()),
          ...(options.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {})
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      })
      resetSession() // Truncate codex.jsonl if reset-per-session is enabled
      const output = readline.createInterface({ input: child.stdout! })

      // Generate a temporary thread ID for session tracking
      const tempThreadId = `codex-${randomUUID()}`

      context = {
        session,
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        nextRequestId: 1,
        stopping: false
      }

      this.sessions.set(tempThreadId, context)
      this.attachProcessListeners(context, tempThreadId)

      this.emitLifecycleEvent(context, 'session/connecting', 'Starting codex app-server')

      // Initialize protocol
      await this.sendRequest(context, 'initialize', {
        clientInfo: {
          name: 'hive_desktop',
          title: 'Hive Desktop',
          version: '1.0.0'
        },
        capabilities: {
          experimentalApi: true
        }
      })

      // Send initialized notification (no response expected)
      this.writeMessage(context, { jsonrpc: '2.0', method: 'initialized' })

      // Read account info (best-effort)
      // TODO(codex): Store account snapshot for spark model eligibility checks
      try {
        await this.sendRequest(context, 'account/read', {})
      } catch (err) {
        log.warn('account/read failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err)
        })
      }

      // Open thread: resume or start fresh
      const threadStartParams: Omit<ThreadStartParams, 'serviceTier'> & { serviceTier?: string | null } = {
        model: options.model ?? null,
        cwd: resolvedCwd,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ...getDefaultCodexRuntimeConfig()
      }

      let threadOpenResponse: unknown
      if (options.resumeThreadId) {
        try {
          const resumeParams: Omit<ThreadResumeParams, 'serviceTier'> & { serviceTier?: string | null } = {
            ...threadStartParams,
            threadId: options.resumeThreadId,
            persistExtendedHistory: false
          }
          threadOpenResponse = await this.sendRequest(context, 'thread/resume', resumeParams)
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            throw error
          }

          log.warn('thread/resume failed with recoverable error, falling back to thread/start', {
            resumeThreadId: options.resumeThreadId,
            error: error instanceof Error ? error.message : String(error)
          })

          this.emitLifecycleEvent(
            context,
            'session/threadResumeFallback',
            `Could not resume thread ${options.resumeThreadId}; starting new thread.`
          )

          threadOpenResponse = await this.sendRequest(context, 'thread/start', threadStartParams)
        }
      } else {
        threadOpenResponse = await this.sendRequest(context, 'thread/start', threadStartParams)
      }

      // Extract thread ID from response
      const responseRecord = threadOpenResponse as ThreadStartResponse | ThreadResumeResponse
      const providerThreadId = responseRecord.thread.id

      if (!providerThreadId) {
        throw new Error('Thread start/resume response did not include a thread id.')
      }

      // Re-key the session from temp ID to the real thread ID
      this.sessions.delete(tempThreadId)
      this.sessions.set(providerThreadId, context)

      // Update session
      this.updateSession(context, {
        status: 'ready',
        threadId: providerThreadId,
        resumeCursor: providerThreadId
      })

      this.emitLifecycleEvent(context, 'session/ready', `Connected to thread ${providerThreadId}`)

      log.info('Session started', {
        threadId: providerThreadId,
        model: options.model,
        cwd: resolvedCwd
      })

      return { ...context.session }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start Codex session.'

      if (context) {
        this.updateSession(context, {
          status: 'error',
          error: message
        })
        this.emitErrorEvent(context, 'session/startFailed', message)

        // Clean up on failure — find and remove the context from sessions
        for (const [key, ctx] of this.sessions.entries()) {
          if (ctx === context) {
            this.stopSession(key)
            break
          }
        }
      }

      throw new Error(message, { cause: error })
    }
  }

  stopSession(threadId: string): void {
    const context = this.sessions.get(threadId)
    if (!context) {
      return
    }

    context.stopping = true

    // Reject all pending requests
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Session stopped before request completed.'))
    }
    context.pending.clear()
    context.pendingApprovals.clear()
    context.pendingUserInputs.clear()

    // Close readline
    context.output.close()

    // Kill child process
    if (!context.child.killed) {
      killChildTree(context.child)
    }

    this.updateSession(context, {
      status: 'closed',
      activeTurnId: null
    })
    this.emitLifecycleEvent(context, 'session/closed', 'Session stopped')
    this.sessions.delete(threadId)
  }

  stopAll(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.stopSession(threadId)
    }
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId)
  }

  getSession(threadId: string): CodexProviderSession | undefined {
    const context = this.sessions.get(threadId)
    return context ? { ...context.session } : undefined
  }

  listSessions(): CodexProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({ ...session }))
  }

  async sendTurn(threadId: string, input: CodexTurnInput): Promise<CodexTurnStartResult> {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`sendTurn: no session found for threadId=${threadId}`)
    }

    if (!context.session.threadId) {
      throw new Error('sendTurn: session has no threadId')
    }

    // Reset child tracking for new turn
    context.collabReceiverTurns.clear()

    // Build the turn input array
    const turnInput =
      input.input && input.input.length > 0
        ? input.input
        : input.text
          ? [{ type: 'text' as const, text: input.text, text_elements: [] }]
          : []

    const params: Record<string, unknown> = {
      threadId: context.session.threadId,
      input: turnInput
    }

    if (input.model) {
      params.model = input.model
    }

    if (input.reasoningEffort) {
      params.effort = input.reasoningEffort
    }

    // Enable reasoning summary streaming so reasoning deltas appear in the UI.
    // Without this parameter the server sends no reasoning deltas at all.
    params.summary = 'auto'

    if (input.serviceTier !== undefined) {
      params.serviceTier = input.serviceTier
    }

    if (input.interactionMode || input.developerInstructions) {
      const mode = input.interactionMode ?? 'default'
      // collaborationMode is required for request_user_input availability;
      // its settings block independently specifies model/reasoning for this mode context
      params.collaborationMode = {
        mode,
        settings: {
          model: input.model ?? context.session.model ?? CODEX_DEFAULT_MODEL,
          reasoning_effort: input.reasoningEffort ?? 'medium', // snake_case: Codex API uses snake_case for this field in the collaborationMode settings block
          developer_instructions:
            input.developerInstructions ??
            (mode === 'plan'
              ? CODEX_PLAN_DEVELOPER_INSTRUCTIONS
              : CODEX_DEFAULT_DEVELOPER_INSTRUCTIONS)
        }
      }
    }

    // Update session to running before sending
    this.updateSession(context, { status: 'running' })
    this.emitLifecycleEvent(context, 'turn/sending', 'Sending turn')

    const response = await this.sendRequest<TurnStartResponse>(context, 'turn/start', params)
    const turnId = response.turn.id

    // Update active turn
    this.updateSession(context, {
      activeTurnId: turnId || null
    })

    return {
      turnId,
      threadId: context.session.threadId
    }
  }

  // ── HITL / control-plane API ──────────────────────────────────

  respondToApproval(
    threadId: string,
    requestId: string,
    decision: HiveApprovalDecision
  ): void {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`respondToApproval: no session for threadId=${threadId}`)
    }

    const pending = context.pendingApprovals.get(requestId)
    if (!pending) {
      throw new Error(`respondToApproval: no pending approval for requestId=${requestId}`)
    }

    const codexDecision =
      pending.method === 'item/fileChange/requestApproval'
        ? toCodexFileChangeApprovalDecision(decision)
        : toCodexCommandApprovalDecision(decision)

    this.writeMessage(context, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { decision: codexDecision }
    })

    context.pendingApprovals.delete(requestId)

    this.emitLifecycleEvent(
      context,
      'approval/responded',
      `Approval ${requestId} responded with ${codexDecision}`
    )
  }

  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Array<{ id: string; answer: string }>
  ): void {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`respondToUserInput: no session for threadId=${threadId}`)
    }

    const pending = context.pendingUserInputs.get(requestId)
    if (!pending) {
      throw new Error(`respondToUserInput: no pending user input for requestId=${requestId}`)
    }

    // Convert answers array into a map keyed by question id,
    // wrapping each value in the generated ToolRequestUserInputAnswer format
    const answersMap: Record<string, ToolRequestUserInputAnswer> = {}
    for (const { id, answer } of answers) {
      answersMap[id] = { answers: [answer] }
    }

    this.writeMessage(context, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { answers: answersMap }
    })

    context.pendingUserInputs.delete(requestId)

    this.emitEvent({
      id: randomUUID(),
      kind: 'notification',
      provider: 'codex',
      threadId: context.session.threadId ?? '',
      createdAt: new Date().toISOString(),
      method: 'item/tool/requestUserInput/answered',
      requestId,
      payload: {
        requestId,
        answers: answersMap
      }
    })
  }

  rejectUserInput(threadId: string, requestId: string): void {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`rejectUserInput: no session for threadId=${threadId}`)
    }

    const pending = context.pendingUserInputs.get(requestId)
    if (!pending) {
      throw new Error(`rejectUserInput: no pending user input for requestId=${requestId}`)
    }

    this.writeMessage(context, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { answers: {}, rejected: true }
    })

    context.pendingUserInputs.delete(requestId)

    this.emitLifecycleEvent(context, 'userInput/rejected', `User input ${requestId} rejected`)
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`interruptTurn: no session for threadId=${threadId}`)
    }

    const targetTurnId = turnId ?? context.session.activeTurnId

    const params: TurnInterruptParams = {
      threadId: context.session.threadId!,
      turnId: targetTurnId ?? ''
    }

    await this.sendRequest(context, 'turn/interrupt', params)

    this.updateSession(context, {
      status: 'ready',
      activeTurnId: null
    })

    this.emitLifecycleEvent(context, 'turn/interrupted', 'Turn interrupted')
  }

  async readThread(threadId: string): Promise<unknown> {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`readThread: no session for threadId=${threadId}`)
    }

    const params: ThreadReadParams = {
      threadId: context.session.threadId!,
      includeTurns: true
    }

    return this.sendRequest(context, 'thread/read', params)
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<unknown> {
    const context = this.sessions.get(threadId)
    if (!context) {
      throw new Error(`rollbackThread: no session for threadId=${threadId}`)
    }

    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error('numTurns must be an integer >= 1')
    }

    const params: ThreadRollbackParams = {
      threadId: context.session.threadId!,
      numTurns
    }

    const response = await this.sendRequest(context, 'thread/rollback', params)

    this.updateSession(context, { status: 'ready', activeTurnId: null })
    this.emitLifecycleEvent(context, 'thread/rolledBack', `Rolled back ${numTurns} turn(s)`)

    return response
  }

  getPendingApprovals(threadId: string): PendingApprovalRequest[] {
    const context = this.sessions.get(threadId)
    if (!context) {
      return []
    }
    return Array.from(context.pendingApprovals.values())
  }

  getPendingUserInputs(threadId: string): PendingUserInputRequest[] {
    const context = this.sessions.get(threadId)
    if (!context) {
      return []
    }
    return Array.from(context.pendingUserInputs.values())
  }

  // ── Process listeners ─────────────────────────────────────────

  private attachProcessListeners(context: CodexSessionContext, trackingId: string): void {
    context.output.on('line', (line) => {
      this.handleStdoutLine(context, line)
    })

    if (context.child.stderr) {
      context.child.stderr.on('data', (chunk: Buffer) => {
        const raw = chunk.toString()
        const lines = raw.split(/\r?\n/g)
        for (const rawLine of lines) {
          const classified = classifyCodexStderrLine(rawLine)
          if (!classified) {
            continue
          }

          log.warn('codex stderr', { message: classified.message })
          logCodexLifecycleEvent('stderr', { message: classified.message })
          // Emit as a notification rather than an error — stderr output
          // from the Codex app-server often includes benign warnings,
          // progress info, or non-standard log formats that should not
          // abort the current turn or trigger session error states.
          this.emitEvent({
            id: randomUUID(),
            kind: 'notification',
            provider: 'codex',
            threadId: context.session.threadId ?? '',
            createdAt: new Date().toISOString(),
            method: 'process/stderr',
            message: classified.message
          })
        }
      })
    }

    context.child.on('error', (error) => {
      const message = error.message || 'codex app-server process errored.'
      logCodexLifecycleEvent('process/error', { message })
      this.updateSession(context, {
        status: 'error',
        error: message
      })
      this.emitErrorEvent(context, 'process/error', message)
    })

    context.child.on('exit', (code, signal) => {
      logCodexLifecycleEvent('process/exit', { code: code ?? null, signal: signal ?? null })

      if (context.stopping) {
        return
      }

      const message = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`
      this.updateSession(context, {
        status: 'closed',
        activeTurnId: null,
        error: code === 0 ? context.session.error : message
      })
      this.emitLifecycleEvent(context, 'session/exited', message)

      // Remove from sessions map
      for (const [key, ctx] of this.sessions.entries()) {
        if (ctx === context) {
          this.sessions.delete(key)
          break
        }
      }

      log.info('Process exited', { code, signal, trackingId })
    })
  }

  // ── Message handling ───────────��──────────────────────────────

  /** @internal — exposed for testing */
  handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.emitErrorEvent(
        context,
        'protocol/parseError',
        'Received invalid JSON from codex app-server.'
      )
      return
    }

    logCodexMessage('incoming', parsed)

    if (!parsed || typeof parsed !== 'object') {
      this.emitErrorEvent(
        context,
        'protocol/invalidMessage',
        'Received non-object protocol message.'
      )
      return
    }

    if (isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed)
      return
    }

    if (isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed)
      return
    }

    if (isResponse(parsed)) {
      this.handleResponse(context, parsed)
      return
    }

    this.emitErrorEvent(
      context,
      'protocol/unrecognizedMessage',
      'Received protocol message in an unknown shape.'
    )
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: ServerNotification
  ): void {
    const route = this.readRouteFields(notification.params)

    // Track collab subagent spawns (must run before child detection)
    this.rememberCollabReceiverTurns(context, notification.params, route.turnId)

    // Detect if this notification is from a child thread
    const childParentTurnId = this.readChildParentTurnId(context, notification.params)
    const isChildConversation = childParentTurnId !== undefined

    // Suppress lifecycle notifications from child threads
    if (isChildConversation && this.shouldSuppressChildConversationNotification(notification.method)) {
      return
    }

    // Extract textDelta for streaming text notifications (matches t3code pattern)
    const textDelta =
      notification.method === 'item/agentMessage/delta'
        ? asString(asObject(notification.params)?.delta)
        : undefined

    const providerConversationId = this.readProviderConversationId(notification.params)

    // Emit event — child events get parent's turnId for proper attribution
    this.emitEvent({
      id: randomUUID(),
      kind: 'notification',
      provider: 'codex',
      threadId: context.session.threadId ?? '',
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...((childParentTurnId ?? route.turnId) ? { turnId: childParentTurnId ?? route.turnId } : {}),
      ...(route.itemId ? { itemId: route.itemId } : {}),
      textDelta,
      ...(isChildConversation && providerConversationId
        ? { childThreadId: providerConversationId }
        : {}),
      payload: notification.params
    })

    // Handle session lifecycle notifications — only for parent thread
    if (notification.method === 'turn/started') {
      if (isChildConversation) return
      const turnId = notification.params.turn.id
      this.updateSession(context, {
        status: 'running',
        activeTurnId: turnId ?? null
      })
      return
    }

    if (notification.method === 'turn/completed') {
      if (isChildConversation) return
      context.collabReceiverTurns.clear()
      const status = notification.params.turn.status
      this.updateSession(context, {
        status: status === 'failed' ? 'error' : 'ready',
        activeTurnId: null
      })
      return
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: ServerRequest): void {
    const requestId = randomUUID()
    const route = this.readRouteFields(request.params)

    // Detect if this request is from a child thread — use parent's turnId for attribution
    const childParentTurnId = this.readChildParentTurnId(context, request.params)
    const effectiveTurnId = childParentTurnId ?? route.turnId
    const providerConversationId = this.readProviderConversationId(request.params)
    const isChildConversation = childParentTurnId !== undefined

    // Track approval requests
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval' ||
      request.method === 'item/fileRead/requestApproval'
    ) {
      const params = request.params as
        | CommandExecutionRequestApprovalParams
        | FileChangeRequestApprovalParams

      context.pendingApprovals.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        method: request.method,
        threadId: context.session.threadId ?? '',
        payload: request.params,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...('itemId' in params ? { itemId: params.itemId } : {})
      })
    }

    // Track user input requests
    if (request.method === 'item/tool/requestUserInput') {
      const params = request.params as ToolRequestUserInputParams

      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId ?? '',
        turnId: params.turnId,
        itemId: params.itemId
      })
    }

    this.emitEvent({
      id: randomUUID(),
      kind: 'request',
      provider: 'codex',
      threadId: context.session.threadId ?? '',
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(route.itemId ? { itemId: route.itemId } : {}),
      requestId,
      ...(isChildConversation && providerConversationId
        ? { childThreadId: providerConversationId }
        : {}),
      payload: request.params
    })
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id)
    const pending = context.pending.get(key)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    context.pending.delete(key)

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`))
      return
    }

    pending.resolve(response.result)
  }

  // ── JSON-RPC send ─────────────────────────────────────────────

  /** @internal — exposed for testing */
  sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000
  ): Promise<TResponse> {
    const id = context.nextRequestId
    context.nextRequestId += 1

    return new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id))
        reject(new Error(`Timed out waiting for ${method}.`))
      }, timeoutMs)

      context.pending.set(String(id), {
        method,
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject
      })

      this.writeMessage(context, {
        jsonrpc: '2.0',
        method,
        id,
        params
      })
    })
  }

  /** @internal — exposed for testing */
  writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message)
    if (!context.child.stdin?.writable) {
      throw new Error('Cannot write to codex app-server stdin.')
    }

    logCodexMessage('outgoing', message)
    context.child.stdin.write(`${encoded}\n`)
  }

  // ── Event emission helpers ────────────────────────────────────

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: randomUUID(),
      kind: 'session',
      provider: 'codex',
      threadId: context.session.threadId ?? '',
      createdAt: new Date().toISOString(),
      method,
      message
    })
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: randomUUID(),
      kind: 'error',
      provider: 'codex',
      threadId: context.session.threadId ?? '',
      createdAt: new Date().toISOString(),
      method,
      message
    })
  }

  private emitEvent(event: CodexManagerEvent): void {
    this.emit('event', event)
  }

  // ── Session state helpers ─────────────────────────────────────

  private updateSession(
    context: CodexSessionContext,
    updates: Partial<CodexProviderSession>
  ): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString()
    }
  }

  // ── Protocol helpers ──────────────────────────────────────────

  // ── Collab subagent tracking helpers ────────────────────────

  private readProviderConversationId(params: unknown): string | undefined {
    const p = asObject(params)
    return (
      asString(p?.threadId) ??
      asString(asObject(p?.thread)?.id) ??
      asString(p?.conversationId)
    )
  }

  private readChildParentTurnId(
    context: CodexSessionContext,
    params: unknown
  ): string | undefined {
    const providerConversationId = this.readProviderConversationId(params)
    if (!providerConversationId) return undefined
    return context.collabReceiverTurns.get(providerConversationId)
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: string | undefined
  ): void {
    if (!parentTurnId) return
    const payload = asObject(params)
    const item = asObject(payload?.item) ?? payload
    const itemType = asString(item?.type) ?? asString(item?.kind)
    if (itemType !== 'collabAgentToolCall') return

    const receiverThreadIds =
      (item?.receiverThreadIds as string[] | undefined) ?? []
    for (const id of receiverThreadIds) {
      if (typeof id === 'string') {
        context.collabReceiverTurns.set(id, parentTurnId)
      }
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    return (
      method === 'thread/started' ||
      method === 'thread/status/changed' ||
      method === 'thread/archived' ||
      method === 'thread/unarchived' ||
      method === 'thread/closed' ||
      method === 'thread/compacted' ||
      method === 'thread/name/updated' ||
      method === 'thread/tokenUsage/updated' ||
      method === 'turn/started' ||
      method === 'turn/completed' ||
      method === 'turn/aborted' ||
      method === 'turn/plan/updated' ||
      method === 'item/plan/delta'
    )
  }

  // ── Route field extraction ─────────────────────────────────

  private readRouteFields(params: unknown): {
    turnId?: string
    itemId?: string
  } {
    const paramsObj = asObject(params)
    if (!paramsObj) return {}

    const turnObj = asObject(paramsObj.turn)
    const itemObj = asObject(paramsObj.item)

    const turnId = asString(paramsObj.turnId) ?? asString(turnObj?.id)
    const itemId = asString(paramsObj.itemId) ?? asString(itemObj?.id)

    return {
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {})
    }
  }
}
