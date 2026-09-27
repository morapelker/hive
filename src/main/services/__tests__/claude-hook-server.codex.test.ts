// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'

const backendManagerMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

const telemetryMocks = vi.hoisted(() => ({
  handleClaudeCliHiveTelemetryHook: vi.fn().mockResolvedValue(undefined)
}))

const usageMocks = vi.hoisted(() => ({
  scheduleSessionUsageReport: vi.fn()
}))

const ptyServiceMocks = vi.hoisted(() => ({
  has: vi.fn(() => true),
  write: vi.fn()
}))

const rolloutMocks = vi.hoisted(() => ({
  readCodexPlanText: vi.fn((): string | null => null)
}))

vi.mock('../pty-service', () => ({
  ptyService: ptyServiceMocks
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: backendManagerMocks.publishDesktopBackendEvent
}))

vi.mock('../hive-enterprise-claude-cli-telemetry', () => ({
  handleClaudeCliHiveTelemetryHook: telemetryMocks.handleClaudeCliHiveTelemetryHook
}))

vi.mock('../codex-cli-rollout', () => ({
  readCodexPlanText: rolloutMocks.readCodexPlanText
}))

interface FakeSession {
  id: string
  claude_session_id: string | null
  agent_sdk: string
  mode: string
  model_id: string | null
}

const dbMocks = vi.hoisted(() => ({
  sessions: new Map<string, FakeSession>(),
  updateSession: vi.fn(),
  getSessionByClaudeSessionId: vi.fn()
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSession: (id: string) => dbMocks.sessions.get(id) ?? null,
    getSessionByClaudeSessionId: dbMocks.getSessionByClaudeSessionId,
    updateSession: (id: string, update: Partial<FakeSession>) => {
      dbMocks.updateSession(id, update)
      const row = dbMocks.sessions.get(id)
      if (row) Object.assign(row, update)
    }
  })
}))

vi.mock('../usage/session-usage-service', () => ({
  scheduleSessionUsageReport: usageMocks.scheduleSessionUsageReport
}))

import {
  closeClaudeHookServer,
  getClaudeHookServer,
  subscribeClaudeCliStatus,
  subscribeCliHookEvents,
  __resetClaudeCliSessionIdCaptureForTests,
  type ClaudeCliStatusPayload
} from '../claude-hook-server'
import {
  hasBlockingClaudeCliInteraction,
  holdClaudeCliInteraction,
  releaseClaudeCliInteraction
} from '../claude-cli-interaction-ledger'
import { cliHookTransportRouter } from '../cli-hook-transport-router'
import {
  isClaudeCliPlanAutoApproveArmed,
  setClaudeCliPlanAutoApprove
} from '../claude-cli-plan-auto-approve'

const THREAD = '01a07dbd-6a11-7982-a2b6-ceaa43736708'
const TRANSCRIPT = `/Users/me/.codex/sessions/2026/09/08/rollout-2026-09-08T00-19-20-${THREAD}.jsonl`

function codexBody(
  event: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: THREAD,
    turn_id: 'turn-1',
    transcript_path: TRANSCRIPT,
    cwd: '/repo/wt',
    hook_event_name: event,
    model: 'gpt-5.5',
    permission_mode: 'bypassPermissions',
    ...extra
  }
}

async function postCodexHook(
  port: number,
  sessionId: string,
  path: 'session' | 'start' | 'stop' | 'tool' | 'permission' | 'subagent',
  body: Record<string, unknown>
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/codex-hook/${sessionId}/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' }
  })
  return { status: response.status, text: await response.text() }
}

function collectStatuses(): ClaudeCliStatusPayload[] {
  const statuses: ClaudeCliStatusPayload[] = []
  subscribeClaudeCliStatus((payload) => statuses.push(payload))
  return statuses
}

function seedSession(id: string, overrides: Partial<FakeSession> = {}): void {
  dbMocks.sessions.set(id, {
    id,
    claude_session_id: null,
    agent_sdk: 'codex-cli',
    mode: 'build',
    model_id: 'gpt-5.5',
    ...overrides
  })
}

afterEach(async () => {
  await closeClaudeHookServer()
  vi.clearAllMocks()
  vi.useRealTimers()
  backendManagerMocks.publishDesktopBackendEvent.mockReset()
  rolloutMocks.readCodexPlanText.mockReset()
  rolloutMocks.readCodexPlanText.mockReturnValue(null)
  __resetClaudeCliSessionIdCaptureForTests()
  dbMocks.sessions.clear()
  dbMocks.getSessionByClaudeSessionId.mockReset()
  dbMocks.updateSession.mockReset()
})

describe('codex hook route', () => {
  it('follows a build turn: SessionStart → prompt → tool → Stop', async () => {
    seedSession('s1')
    dbMocks.getSessionByClaudeSessionId.mockReturnValue(null)
    const statuses = collectStatuses()
    const { port } = await getClaudeHookServer()

    const start = await postCodexHook(port, 's1', 'session', codexBody('SessionStart', { source: 'startup' }))
    expect(start.status).toBe(200)
    expect(start.text).toBe('{}')
    // The thread id is captured from the very first hook and announced to the renderer.
    expect(dbMocks.updateSession).toHaveBeenCalledWith('s1', { claude_session_id: THREAD })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      'terminal:claude-session-id:s1',
      THREAD
    )

    await postCodexHook(port, 's1', 'start', codexBody('UserPromptSubmit', { prompt: 'Fix the bug' }))
    await postCodexHook(
      port,
      's1',
      'tool',
      codexBody('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' }, tool_use_id: 'c1' })
    )
    await postCodexHook(
      port,
      's1',
      'tool',
      codexBody('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'c1',
        tool_response: 'ok\n'
      })
    )
    await postCodexHook(
      port,
      's1',
      'stop',
      codexBody('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' })
    )

    expect(statuses.map((s) => [s.status, s.metadata?.hookEventName])).toEqual([
      ['completed', 'SessionStart'],
      ['working', 'UserPromptSubmit'],
      ['completed', 'Stop']
    ])
    // The first prompt is announced for auto ticket creation.
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(OPENCODE_STREAM_CHANNEL, {
      type: 'claude-cli.first-prompt-detected',
      sessionId: 's1',
      data: { promptText: 'Fix the bug' }
    })
    // Telemetry sees the adapted (claude-shaped) hooks for the main turn events.
    expect(telemetryMocks.handleClaudeCliHiveTelemetryHook).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug' })
    )
    expect(usageMocks.scheduleSessionUsageReport).toHaveBeenCalledWith('s1', 'claude-cli-completed')
  })

  it('maps request_user_input to the answering status and leaves its release to the title', async () => {
    seedSession('s2', { claude_session_id: THREAD })
    const statuses = collectStatuses()
    const { port } = await getClaudeHookServer()
    await postCodexHook(port, 's2', 'start', codexBody('UserPromptSubmit', { prompt: 'go' }))
    await postCodexHook(
      port,
      's2',
      'tool',
      codexBody('PreToolUse', {
        tool_name: 'request_user_input',
        tool_use_id: 'q1',
        tool_input: {
          questions: [{ id: 'a', header: 'DB', question: 'Which db?', options: [{ label: 'pg', description: '' }] }]
        }
      })
    )
    expect(statuses.at(-1)).toMatchObject({ status: 'answering', metadata: { toolName: 'AskUserQuestion' } })
    expect(hasBlockingClaudeCliInteraction('s2')).toBe(true)
    // Unrelated tool hooks do not clobber the latched question.
    await postCodexHook(
      port,
      's2',
      'tool',
      codexBody('PostToolUse', { tool_name: 'Bash', tool_use_id: 'zz', tool_input: {}, tool_response: '' })
    )
    expect(statuses.at(-1)?.status).toBe('answering')
    // A Default-mode question is non-blocking: codex answers the tool call at
    // once and keeps working. The PostToolUse must not release the question.
    await postCodexHook(
      port,
      's2',
      'tool',
      codexBody('PostToolUse', {
        tool_name: 'request_user_input',
        tool_use_id: 'q1',
        tool_input: {},
        tool_response: { answers: { a: 'pg' } }
      })
    )
    expect(statuses.at(-1)?.status).toBe('answering')
    expect(hasBlockingClaudeCliInteraction('s2')).toBe(true)
    await postCodexHook(
      port,
      's2',
      'tool',
      codexBody('PostToolUse', { tool_name: 'Bash', tool_use_id: 'zy', tool_input: {}, tool_response: '' })
    )
    expect(statuses.at(-1)?.status).toBe('answering')
    // The turn's Stop is a turn boundary for the hook latch, but the title hold
    // (placed by the PTY bridge while it says Action Required) keeps the
    // question surfaced through it and through the next prompt.
    holdClaudeCliInteraction('s2', 'codex-title')
    await postCodexHook(port, 's2', 'stop', codexBody('Stop', { last_assistant_message: 'waiting' }))
    expect(statuses.at(-1)?.status).toBe('answering')
    await postCodexHook(port, 's2', 'start', codexBody('UserPromptSubmit', { prompt: 'meanwhile…' }))
    expect(statuses.at(-1)?.status).toBe('answering')
    expect(hasBlockingClaudeCliInteraction('s2')).toBe(true)
    // Answered: the title drops Action Required and the bridge releases.
    releaseClaudeCliInteraction('s2', 'codex-title')
    expect(hasBlockingClaudeCliInteraction('s2')).toBe(false)
    await postCodexHook(port, 's2', 'stop', codexBody('Stop', { last_assistant_message: 'done' }))
    expect(statuses.at(-1)?.status).toBe('completed')
  })

  it('never lets a transport hold a codex hook', async () => {
    seedSession('s3', { claude_session_id: THREAD })
    const routeHookSpy = vi.spyOn(cliHookTransportRouter, 'routeHook')
    const { port } = await getClaudeHookServer()
    await postCodexHook(
      port,
      's3',
      'tool',
      codexBody('PreToolUse', {
        tool_name: 'request_user_input',
        tool_use_id: 'q1',
        tool_input: { questions: [{ id: 'a', header: 'h', question: 'q', options: [] }] }
      })
    )
    expect(routeHookSpy).toHaveBeenLastCalledWith(
      's3',
      expect.objectContaining({ tool_name: 'AskUserQuestion' }),
      expect.anything(),
      { suppressIdle: false, disableHeldInteractions: true }
    )
    routeHookSpy.mockRestore()
  })

  it('treats Interrupt as a user-interrupt completion', async () => {
    seedSession('s4', { claude_session_id: THREAD })
    const statuses = collectStatuses()
    const { port } = await getClaudeHookServer()
    await postCodexHook(port, 's4', 'start', codexBody('UserPromptSubmit', { prompt: 'go' }))
    await postCodexHook(port, 's4', 'stop', codexBody('Interrupt'))
    expect(statuses.at(-1)).toMatchObject({
      status: 'completed',
      metadata: { hookEventName: 'Stop', reason: 'user_interrupt' }
    })
  })

  it('in Plan mode maps prompts to planning and a Stop with a plan to plan_ready with the plan text', async () => {
    seedSession('s5', { claude_session_id: THREAD, mode: 'plan' })
    rolloutMocks.readCodexPlanText.mockReturnValue('## Plan\n1. Step')
    const statuses = collectStatuses()
    const { port } = await getClaudeHookServer()

    await postCodexHook(port, 's5', 'start', codexBody('UserPromptSubmit', { prompt: 'plan it' }))
    expect(statuses.at(-1)).toMatchObject({ status: 'planning', metadata: { hookEventName: 'UserPromptSubmit' } })

    await postCodexHook(port, 's5', 'stop', codexBody('Stop', { stop_hook_active: false, last_assistant_message: 'plan' }))
    expect(rolloutMocks.readCodexPlanText).toHaveBeenCalledWith(TRANSCRIPT, 'turn-1')
    const tail = statuses.slice(-2)
    expect(tail[0]).toMatchObject({
      status: 'plan_ready',
      metadata: { hookEventName: 'PreToolUse', toolName: 'ExitPlanMode', plan: '## Plan\n1. Step' }
    })
    expect(tail[1]).toMatchObject({ status: 'completed', metadata: { hookEventName: 'Stop' } })
    // The Stop resets the plan latch (the renderer keeps plan_ready from its own send mode).
    expect(hasBlockingClaudeCliInteraction('s5')).toBe(false)

    // Accepting the plan in the TUI submits "Implement the plan." → the implement
    // signal (PostToolUse ExitPlanMode → working). The prompt's own 'working'
    // publish is then deduplicated, and it must never read as 'planning' even
    // though the row still says plan.
    const before = statuses.length
    await postCodexHook(port, 's5', 'start', codexBody('UserPromptSubmit', { prompt: 'Implement the plan.' }))
    const implement = statuses.slice(before)
    expect(implement).toHaveLength(1)
    expect(implement[0]).toMatchObject({
      status: 'working',
      metadata: { hookEventName: 'PostToolUse', toolName: 'ExitPlanMode' }
    })
    expect(telemetryMocks.handleClaudeCliHiveTelemetryHook).toHaveBeenCalledWith(
      's5',
      expect.objectContaining({ hook_event_name: 'UserPromptSubmit', prompt: 'Implement the plan.' })
    )
  })

  it('auto-approves a proposed plan by pressing 1 on the TUI selection when armed', async () => {
    vi.useFakeTimers()
    seedSession('s6', { claude_session_id: THREAD, mode: 'plan' })
    rolloutMocks.readCodexPlanText.mockReturnValue('plan')
    setClaudeCliPlanAutoApprove('s6', true)
    const { port } = await getClaudeHookServer()
    // fetch under fake timers: drive the request manually.
    const request = postCodexHook(port, 's6', 'stop', codexBody('Stop', { stop_hook_active: false }))
    await vi.advanceTimersByTimeAsync(50)
    await request
    expect(isClaudeCliPlanAutoApproveArmed('s6')).toBe(false)
    expect(ptyServiceMocks.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1300)
    expect(ptyServiceMocks.write).toHaveBeenCalledWith('s6', '1')
  })

  it('rebinds the row to a new thread on SessionStart(clear) but not on resume', async () => {
    seedSession('s7', { claude_session_id: THREAD })
    dbMocks.getSessionByClaudeSessionId.mockReturnValue(null)
    const { port } = await getClaudeHookServer()
    await postCodexHook(
      port,
      's7',
      'session',
      codexBody('SessionStart', { session_id: THREAD, source: 'resume' })
    )
    expect(dbMocks.updateSession).not.toHaveBeenCalled()

    const fresh = '01a07dbd-ffff-7982-a2b6-ceaa43736708'
    await postCodexHook(port, 's7', 'session', codexBody('SessionStart', { session_id: fresh, source: 'clear' }))
    expect(dbMocks.updateSession).toHaveBeenCalledWith('s7', { claude_session_id: fresh })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      'terminal:claude-session-id:s7',
      fresh
    )
  })

  it('applies an observed mid-session model switch to the row', async () => {
    seedSession('s8', { claude_session_id: THREAD, model_id: 'gpt-5.5' })
    const { port } = await getClaudeHookServer()
    await postCodexHook(port, 's8', 'start', codexBody('UserPromptSubmit', { prompt: 'a', model: 'gpt-5.5' }))
    expect(dbMocks.updateSession).not.toHaveBeenCalledWith('s8', expect.objectContaining({ model_id: expect.anything() }))
    await postCodexHook(port, 's8', 'stop', codexBody('Stop', { model: 'gpt-5.4-mini' }))
    expect(dbMocks.updateSession).toHaveBeenCalledWith('s8', { model_id: 'gpt-5.4-mini' })
    expect(backendManagerMocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      OPENCODE_STREAM_CHANNEL,
      expect.objectContaining({ type: 'session.model_changed', sessionId: 's8' })
    )
  })

  it('exposes every adapted hook to raw subscribers and drops compaction events', async () => {
    seedSession('s9', { claude_session_id: THREAD })
    const events: string[] = []
    subscribeCliHookEvents((event) => events.push(`${event.cli}:${event.hook.hook_event_name}`))
    const { port } = await getClaudeHookServer()
    await postCodexHook(port, 's9', 'session', codexBody('PreCompact', { trigger: 'auto' }))
    await postCodexHook(port, 's9', 'session', codexBody('SessionStart', { source: 'startup' }))
    expect(events).toEqual(['codex:SessionStart'])
  })

  it('rejects unknown route prefixes', async () => {
    const { port } = await getClaudeHookServer()
    const response = await fetch(`http://127.0.0.1:${port}/other-hook/s/stop`, {
      method: 'POST',
      body: '{}'
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{}')
  })
})
