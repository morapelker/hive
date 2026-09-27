/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const exitCallbacks = new Map<string, (code: number | null) => void>()
  const dataCallbacks = new Map<string, (data: string) => void>()
  const claudeSessionWatchCallbacks = new Map<string, (claudeSessionId: string) => boolean | void>()

  return {
    handlers,
    exitCallbacks,
    dataCallbacks,
    claudeSessionWatchCallbacks,
    publishDesktopBackendEvent: vi.fn(),
    getDatabase: vi.fn(),
    getClaudeHookServer: vi.fn(),
    buildClaudeCliHookSettings: vi.fn(),
    getLastClaudeCliStatus: vi.fn(),
    publishClaudeCliStatus: vi.fn(),
    resetClaudeCliBackgroundWork: vi.fn(),
    subscribeClaudeCliStatus: vi.fn(() => vi.fn()),
    clearClaudeCliInteractions: vi.fn(),
    clearAllClaudeCliInteractions: vi.fn(),
    holdClaudeCliInteraction: vi.fn(),
    releaseClaudeCliInteraction: vi.fn(() => true),
    clearClaudeCliSubagentTracking: vi.fn(),
    clearAllClaudeCliSubagentTracking: vi.fn(),
    ensureProjectTrustCheck: vi.fn(async () => {}),
    ptyService: {
      has: vi.fn(() => false),
      create: vi.fn(() => ({ cols: 120, rows: 40 })),
      onData: vi.fn((terminalId: string, callback: (data: string) => void) => {
        dataCallbacks.set(terminalId, callback)
        return vi.fn(() => dataCallbacks.delete(terminalId))
      }),
      onExit: vi.fn((terminalId: string, callback: (code: number | null) => void) => {
        exitCallbacks.set(terminalId, callback)
        return vi.fn(() => exitCallbacks.delete(terminalId))
      }),
      write: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
      destroyAll: vi.fn(),
      destroyAllAndReap: vi.fn(async () => {})
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('./pty-service', () => ({
  ptyService: mocks.ptyService
}))

vi.mock('./ghostty-service', () => ({
  ghosttyService: {
    setMainWindow: vi.fn(),
    init: vi.fn(),
    loadAddon: vi.fn(),
    isAvailable: vi.fn(() => false),
    isInitialized: vi.fn(() => false),
    createSurface: vi.fn(),
    setFrame: vi.fn(),
    setSize: vi.fn(),
    keyEvent: vi.fn(),
    mouseButton: vi.fn(),
    mousePos: vi.fn(),
    mouseScroll: vi.fn(),
    setFocus: vi.fn(),
    pasteText: vi.fn(),
    focusDiagnostics: vi.fn(),
    destroySurface: vi.fn(),
    shutdown: vi.fn()
  }
}))

vi.mock('./ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({}))
}))

vi.mock('../db', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('./claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: vi.fn(() => '/usr/local/bin/claude'),
  logClaudeBinaryVersion: vi.fn()
}))

vi.mock('./claude-cli-plan-handoff', () => ({
  externalizeGoalHandoffPlan: vi.fn((prompt: string) => prompt)
}))

vi.mock('./claude-trust', () => ({
  ensureProjectTrustCheck: mocks.ensureProjectTrustCheck
}))

// Keep the real writeClaudeCliPrompt (bracketed paste) but stub the timer-based
// submit re-assert with a spy so no real setTimeout leaks across tests.

vi.mock('./claude-cli-pty-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-pty-prompt')>()),
  reassertClaudeCliPromptSubmit: vi.fn()
}))

vi.mock('./claude-session-watcher', () => ({
  watchForClaudeSessionId: vi.fn(() => ({ close: vi.fn() }))
}))

const codexMocks = vi.hoisted(() => ({
  resolveCodexBinaryPath: vi.fn(() => '/opt/homebrew/bin/codex'),
  watchForCodexSessionId: vi.fn(() => ({ close: vi.fn() })),
  findCodexRolloutByIdPrefix: vi.fn((): { threadId: string; filePath: string } | null => null),
  turnWatchers: [] as Array<{ transcriptPath: string; turnId: string | null; onEnd: (end: unknown) => void; close: ReturnType<typeof vi.fn> }>,
  hookSubscribers: new Set<(event: unknown) => void>()
}))

vi.mock('./codex-binary-resolver', () => ({
  resolveCodexBinaryPath: codexMocks.resolveCodexBinaryPath
}))

vi.mock('./codex-cli-rollout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-cli-rollout')>()),
  watchForCodexSessionId: codexMocks.watchForCodexSessionId,
  findCodexRolloutByIdPrefix: codexMocks.findCodexRolloutByIdPrefix,
  watchCodexTurnEnd: vi.fn((transcriptPath: string, turnId: string | null, onEnd: (end: unknown) => void) => {
    const close = vi.fn()
    codexMocks.turnWatchers.push({ transcriptPath, turnId, onEnd, close })
    return { close }
  })
}))

vi.mock('./claude-hook-server', () => ({
  getClaudeHookServer: mocks.getClaudeHookServer,
  buildClaudeCliHookSettings: mocks.buildClaudeCliHookSettings,
  getLastClaudeCliStatus: mocks.getLastClaudeCliStatus,
  publishClaudeCliStatus: mocks.publishClaudeCliStatus,
  resetClaudeCliBackgroundWork: mocks.resetClaudeCliBackgroundWork,
  subscribeClaudeCliStatus: mocks.subscribeClaudeCliStatus,
  subscribeCliHookEvents: vi.fn((subscriber: (event: unknown) => void) => {
    codexMocks.hookSubscribers.add(subscriber)
    return () => codexMocks.hookSubscribers.delete(subscriber)
  })
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

vi.mock('./claude-cli-interaction-ledger', () => ({
  clearClaudeCliInteractions: mocks.clearClaudeCliInteractions,
  clearAllClaudeCliInteractions: mocks.clearAllClaudeCliInteractions,
  holdClaudeCliInteraction: mocks.holdClaudeCliInteraction,
  releaseClaudeCliInteraction: mocks.releaseClaudeCliInteraction
}))

vi.mock('./claude-cli-subagent-tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-subagent-tracker')>()),
  clearClaudeCliSubagentTracking: mocks.clearClaudeCliSubagentTracking,
  clearAllClaudeCliSubagentTracking: mocks.clearAllClaudeCliSubagentTracking
}))

vi.mock('./env-vars', () => ({
  getUserEnvironmentVariables: vi.fn(() => ({}))
}))

vi.mock('./claude-cli-title-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-title-handler')>()),
  applyClaudeCliTitle: vi.fn(async () => undefined)
}))

import type { Session } from '../db/types'
import { cleanupTerminals, createClaudeCliTerminal } from './terminal-pty-bridge'
import { reassertClaudeCliPromptSubmit } from './claude-cli-pty-prompt'
import { applyClaudeCliTitle } from './claude-cli-title-handler'
import { __resetRuntimeRegistryForTests } from '../effect/_shared/runtime'

const THREAD = '01a07df8-e5b1-76d3-8c61-e2ee5fc90528'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'codex-session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'codex-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'codex',
    model_id: 'gpt-5.5',
    model_variant: 'high',
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

let dbState: { session: Session; updateSession: ReturnType<typeof vi.fn> }

function setupDb(session: Session = makeSession()): void {
  const updateSession = vi.fn((_id: string, update: Partial<Session>) => {
    Object.assign(session, update)
  })
  dbState = { session, updateSession }
  mocks.getDatabase.mockReturnValue({
    getSession: vi.fn(() => session),
    getWorktree: vi.fn(() => ({ path: '/repo/worktree' })),
    getConnection: vi.fn(() => ({ path: '/repo/connection' })),
    getProject: vi.fn(() => ({ id: session.project_id, path: '/repo', kind: 'git' })),
    getSetting: vi.fn(() => null),
    getSessionByClaudeSessionId: vi.fn(() => null),
    updateSession,
    updateProjectTrustCheck: vi.fn(),
    getWorktreeBySessionId: vi.fn(() => null)
  })
}

function emitPty(data: string): void {
  mocks.dataCallbacks.get('codex-session-1')?.(data)
}

function title(text: string): string {
  return `\x1b]0;${text}\x07`
}

function spawnArgs(): string[] {
  const [, options] = mocks.ptyService.create.mock.calls.at(-1)! as unknown as [string, { args: string[] }]
  return options.args
}

describe('Codex CLI terminal wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.handlers.clear()
    mocks.exitCallbacks.clear()
    mocks.dataCallbacks.clear()
    codexMocks.hookSubscribers.clear()
    codexMocks.turnWatchers.length = 0
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()

    setupDb()
    mocks.ptyService.has.mockReturnValue(false)
    mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
    mocks.publishDesktopBackendEvent.mockResolvedValue(true)
    mocks.getLastClaudeCliStatus.mockReturnValue(undefined)
    codexMocks.findCodexRolloutByIdPrefix.mockReturnValue(null)
  })

  afterEach(async () => {
    await cleanupTerminals()
    vi.useRealTimers()
  })

  it('spawns the codex TUI with bypass, model/effort, trust, hooks, the title channel and the argv prompt', async () => {
    const result = await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'Implement the ticket' })

    expect(result).toEqual({ success: true, cols: 120, rows: 40 })
    // No claude folder-trust pre-flight, no claude hook settings for a codex session.
    expect(mocks.ensureProjectTrustCheck).not.toHaveBeenCalled()
    expect(mocks.buildClaudeCliHookSettings).not.toHaveBeenCalled()
    expect(codexMocks.resolveCodexBinaryPath).toHaveBeenCalled()

    const [, options] = mocks.ptyService.create.mock.calls.at(-1)! as unknown as [
      string,
      { args: string[]; command: string; cwd: string }
    ]
    expect(options.command).toBe('/opt/homebrew/bin/codex')
    expect(options.cwd).toBe('/repo/worktree')
    const args = options.args
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox')
    expect(args).toContain('check_for_update_on_startup=false')
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5.5'])
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args.find((a) => a.startsWith('projects={'))).toContain('"/repo"={trust_level="trusted"}')
    expect(args.find((a) => a.startsWith('projects={'))).toContain('"/repo/worktree"={trust_level="trusted"}')
    expect(args.filter((a) => a.startsWith('hooks.')).length).toBeGreaterThanOrEqual(11)
    expect(args.find((a) => a.startsWith('hooks.Stop='))).toContain(
      'http://127.0.0.1:45678/codex-hook/codex-session-1/stop'
    )
    expect(args.find((a) => a.startsWith('hooks.state='))).toMatch(/trusted_hash="sha256:/)
    expect(args).toContain('tui.terminal_title=["run-state","thread-id","thread-title","activity"]')
    expect(args.at(-1)).toBe('Implement the ticket')
    // The prompt is in flight: no idle publish.
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    // No thread id yet → the rollout watcher is the fallback for id capture.
    expect(codexMocks.watchForCodexSessionId).toHaveBeenCalledWith('/repo/worktree', expect.any(Function))
  })

  it('does not paste the prompt again when a racing second create call carries the same prompt', async () => {
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'Implement the ticket' })
    expect(spawnArgs().at(-1)).toBe('Implement the ticket')
    mocks.ptyService.has.mockReturnValue(true)
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'Implement the ticket' })
    expect(mocks.ptyService.write).not.toHaveBeenCalled()
    expect(reassertClaudeCliPromptSubmit).not.toHaveBeenCalled()
    // A genuinely new prompt for the live PTY is still pasted.
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'Now do the follow-up' })
    expect(mocks.ptyService.write).toHaveBeenCalledWith(
      'codex-session-1',
      '\x1b[200~Now do the follow-up\x1b[201~\r'
    )
  })

  it('completes a turn from the rollout when it ends without a Stop hook, flagging a failure', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    const emitHook = (hook: Record<string, unknown>): void => {
      for (const subscriber of codexMocks.hookSubscribers) {
        subscriber({ sessionId: 'codex-session-1', cli: 'codex', hook })
      }
    }
    emitHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go',
      transcript_path: '/rollout.jsonl',
      turn_id: 'turn-1'
    })
    expect(codexMocks.turnWatchers).toHaveLength(1)
    expect(codexMocks.turnWatchers[0]).toMatchObject({ transcriptPath: '/rollout.jsonl', turnId: 'turn-1' })

    // A Stop hook owns the normal path: the tail is dropped.
    emitHook({ hook_event_name: 'Stop', transcript_path: '/rollout.jsonl', turn_id: 'turn-1' })
    expect(codexMocks.turnWatchers[0].close).toHaveBeenCalled()

    // Next turn fails with an API error: no Stop, but the rollout records task_complete.error.
    emitHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'again',
      transcript_path: '/rollout.jsonl',
      turn_id: 'turn-2'
    })
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    codexMocks.turnWatchers[1].onEnd({
      kind: 'complete',
      turnId: 'turn-2',
      error: 'unexpected status 404 Not Found',
      lastAgentMessage: null
    })
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'codex-session-1',
      status: 'completed',
      metadata: { reason: 'codex_turn_ended', apiError: 'codex_turn_failed' }
    })
    expect(mocks.clearClaudeCliInteractions).toHaveBeenCalledWith('codex-session-1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('claude-cli:api-error', {
      sessionId: 'codex-session-1',
      error: 'codex_turn_failed',
      errorDetails: 'unexpected status 404 Not Found'
    })
  })

  it('resumes a known thread and publishes idle when there is no prompt', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    expect(spawnArgs().slice(0, 2)).toEqual(['resume', THREAD])
    expect(codexMocks.watchForCodexSessionId).not.toHaveBeenCalled()
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'codex-session-1',
      status: 'completed',
      metadata: { reason: 'pty_start' }
    })
  })

  it('plan mode: withholds the prompt, then Shift+Tabs and pastes once the title says Ready', async () => {
    setupDb(makeSession({ mode: 'plan' }))
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'Plan the refactor' })
    mocks.ptyService.has.mockReturnValue(true)
    expect(spawnArgs()).not.toContain('Plan the refactor')
    expect(mocks.ptyService.write).not.toHaveBeenCalled()

    // First paint: Ready, then MCP startup interrupts the settle window.
    emitPty(title('Ready'))
    await vi.advanceTimersByTimeAsync(800)
    emitPty(title(`Starting | ${THREAD.slice(0, 29)}... | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.ptyService.write).not.toHaveBeenCalled()
    emitPty(title(`Ready | ${THREAD.slice(0, 29)}... | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(1_199)
    expect(mocks.ptyService.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.ptyService.write).toHaveBeenNthCalledWith(1, 'codex-session-1', '\x1b[Z')
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.ptyService.write).toHaveBeenNthCalledWith(
      2,
      'codex-session-1',
      '\x1b[200~Plan the refactor\x1b[201~\r'
    )
    expect(reassertClaudeCliPromptSubmit).toHaveBeenCalledWith('codex-session-1')
    // A second Ready must not deliver twice.
    emitPty(title(`Ready | ${THREAD.slice(0, 29)}... | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.ptyService.write).toHaveBeenCalledTimes(2)
  })

  it('slash prompts go through the composer too, and the fallback timer covers a silent title channel', async () => {
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: '/goal ship it' })
    mocks.ptyService.has.mockReturnValue(true)
    expect(spawnArgs().some((a) => a.startsWith('/goal'))).toBe(false)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(mocks.ptyService.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // Build mode: no Shift+Tab, straight to the paste.
    expect(mocks.ptyService.write).toHaveBeenCalledTimes(1)
    expect(mocks.ptyService.write).toHaveBeenCalledWith('codex-session-1', '\x1b[200~/goal ship it\x1b[201~\r')
  })

  it('once the title channel speaks, only a settled Ready delivers (no blind fallback)', async () => {
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: '/goal ship it' })
    mocks.ptyService.has.mockReturnValue(true)
    emitPty(title('Starting'))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(mocks.ptyService.write).not.toHaveBeenCalled()
    emitPty(title(`Ready | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(1_200)
    expect(mocks.ptyService.write).toHaveBeenCalledWith('codex-session-1', '\x1b[200~/goal ship it\x1b[201~\r')
  })

  it('captures the thread id from the title (completed by the untruncated fallback) and closes the watcher', async () => {
    const close = vi.fn()
    codexMocks.watchForCodexSessionId.mockReturnValue({ close })
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'go' })
    emitPty(title(`Working | ${THREAD.slice(0, 29)}... | ${THREAD}`))
    expect(dbState.updateSession).toHaveBeenCalledWith('codex-session-1', { claude_session_id: THREAD })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      'terminal:claude-session-id:codex-session-1',
      THREAD
    )
    expect(close).toHaveBeenCalled()
  })

  it('resolves a truncated title id against the rollout folder', async () => {
    codexMocks.findCodexRolloutByIdPrefix.mockReturnValue({ threadId: THREAD, filePath: '/x.jsonl' })
    await createClaudeCliTerminal('codex-session-1', { pendingPrompt: 'go' })
    emitPty(title(`Working | ${THREAD.slice(0, 29)}... | Some thread title`))
    expect(codexMocks.findCodexRolloutByIdPrefix).toHaveBeenCalledWith(THREAD.slice(0, 29))
    expect(dbState.updateSession).toHaveBeenCalledWith('codex-session-1', { claude_session_id: THREAD })
  })

  it('names the session from the idle thread title but not from the interim prompt echo', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    for (const subscriber of codexMocks.hookSubscribers) {
      subscriber({
        sessionId: 'codex-session-1',
        cli: 'codex',
        hook: { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with exactly the word done. Do not run tools.' }
      })
    }
    emitPty(title(`Working | ${THREAD.slice(0, 29)}... | Reply with exactly the word done. Do`))
    emitPty(title(`Ready | ${THREAD.slice(0, 29)}... | Reply with exactly the word done. Do`))
    expect(applyClaudeCliTitle).not.toHaveBeenCalled()
    emitPty(title(`Ready | ${THREAD.slice(0, 29)}... | Reply with done`))
    expect(applyClaudeCliTitle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'codex-session-1', title: 'Reply with done' })
    )
    emitPty(title(`Ready | ${THREAD.slice(0, 29)}... | Another later title`))
    expect(applyClaudeCliTitle).toHaveBeenCalledTimes(1)
  })

  it('mirrors a Working→Ready title transition to completed when no Stop hook moved the status', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    emitPty(title(`Working | ${THREAD}`))
    emitPty(title(`Ready | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'codex-session-1',
      status: 'completed',
      metadata: { reason: 'codex_title_ready' }
    })
    expect(mocks.clearClaudeCliInteractions).toHaveBeenCalledWith('codex-session-1')
  })

  it('publishes answering while the title says Action Required and working once it stops', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.clearClaudeCliInteractions.mockClear()
    // Exactly what codex 0.154.0 emits around a request_user_input question
    // (the blink alternates the prefix; spinner frames trail the thread items).
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    mocks.holdClaudeCliInteraction.mockClear()
    mocks.releaseClaudeCliInteraction.mockClear()
    emitPty(title(`Working | ${THREAD} ⠧`))
    expect(mocks.holdClaudeCliInteraction).not.toHaveBeenCalled()
    emitPty(title(`[ ! ] Action Required | ${THREAD} ⠧`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledTimes(1)
    expect(mocks.publishClaudeCliStatus).toHaveBeenLastCalledWith({
      sessionId: 'codex-session-1',
      status: 'answering',
      metadata: { reason: 'codex_title_action_required' }
    })
    // The ledger is held for as long as the title says so: a non-blocking
    // question's turn keeps firing hooks (and its Stop) with the question open.
    expect(mocks.holdClaudeCliInteraction).toHaveBeenCalledWith('codex-session-1', 'codex-title')
    expect(mocks.releaseClaudeCliInteraction).not.toHaveBeenCalled()
    // Blinks while it already holds are no-ops; a blink after something else
    // moved the status (a Stop fired with the question still open) re-asserts.
    mocks.getLastClaudeCliStatus.mockReturnValue('answering')
    emitPty(title(`[ . ] Action Required | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledTimes(1)
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    emitPty(title(`[ ! ] Action Required | ${THREAD} | Ask color preference`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledTimes(2)
    expect(mocks.publishClaudeCliStatus.mock.calls.every(([p]) => p.status === 'answering')).toBe(true)
    mocks.getLastClaudeCliStatus.mockReturnValue('answering')
    expect(mocks.clearClaudeCliInteractions).not.toHaveBeenCalled()
    // No naming from an action-required title (the run-state item is absent).
    expect(applyClaudeCliTitle).not.toHaveBeenCalled()

    // Answered: no PostToolUse hook fires, the title just resumes the run state.
    mocks.publishClaudeCliStatus.mockClear()
    emitPty(title(`Working | ${THREAD} | Ask color preference ⠋`))
    expect(mocks.releaseClaudeCliInteraction).toHaveBeenCalledWith('codex-session-1', 'codex-title')
    expect(mocks.clearClaudeCliInteractions).toHaveBeenCalledWith('codex-session-1')
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledTimes(1)
    expect(mocks.publishClaudeCliStatus).toHaveBeenLastCalledWith({
      sessionId: 'codex-session-1',
      status: 'working',
      metadata: { reason: 'codex_title_action_resolved' }
    })
    // A plain Working title afterwards is not another release.
    emitPty(title(`Working | ${THREAD} | Ask color preference ⠙`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledTimes(1)
    expect(mocks.releaseClaudeCliInteraction).toHaveBeenCalledTimes(1)
  })

  it('lifts the title hold when the codex process exits mid-question', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.holdClaudeCliInteraction.mockClear()
    mocks.releaseClaudeCliInteraction.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    emitPty(title(`[ ! ] Action Required | ${THREAD}`))
    expect(mocks.holdClaudeCliInteraction).toHaveBeenCalledWith('codex-session-1', 'codex-title')
    mocks.exitCallbacks.get('codex-session-1')?.(0)
    expect(mocks.releaseClaudeCliInteraction).toHaveBeenCalledWith('codex-session-1', 'codex-title')
  })

  it('re-asserts answering after a Stop or an Escape moved the session off the question', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.clearClaudeCliInteractions.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    emitPty(title(`[ ! ] Action Required | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'answering' })
    )
    // Dismissed without an answer (Escape mirrored to completed by the
    // keystroke handler): the title stops blinking and nothing is released.
    mocks.publishClaudeCliStatus.mockClear()
    emitPty(title(`Ready | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    expect(mocks.clearClaudeCliInteractions).not.toHaveBeenCalled()
  })

  it('leaves a hook-latched permission or plan alone while the title says Action Required', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.clearClaudeCliInteractions.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('plan_ready')
    emitPty(title(`[ ! ] Action Required | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    // The plan is resolved by the implement prompt, never by the title.
    emitPty(title(`Working | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    expect(mocks.clearClaudeCliInteractions).not.toHaveBeenCalled()

    // A PermissionRequest-latched approval is kept, and released with the title.
    mocks.getLastClaudeCliStatus.mockReturnValue('permission')
    emitPty(title(`[ ! ] Action Required | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    emitPty(title(`Working | ${THREAD}`))
    expect(mocks.clearClaudeCliInteractions).toHaveBeenCalledWith('codex-session-1')
    expect(mocks.publishClaudeCliStatus).toHaveBeenLastCalledWith({
      sessionId: 'codex-session-1',
      status: 'working',
      metadata: { reason: 'codex_title_action_resolved' }
    })
  })

  it('completes a turn whose question was answered right before Ready', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    emitPty(title(`Working | ${THREAD}`))
    mocks.getLastClaudeCliStatus.mockReturnValue('answering')
    emitPty(title(`[ ! ] Action Required | ${THREAD}`))
    // The release publishes working, which the Ready mirror then completes
    // (the dedup map is what getLastClaudeCliStatus reads in production).
    mocks.publishClaudeCliStatus.mockImplementation(({ status }) => {
      mocks.getLastClaudeCliStatus.mockReturnValue(status)
    })
    emitPty(title(`Ready | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus.mock.calls.map(([p]) => p.status)).toEqual(['working', 'completed'])
  })

  it('publishes a title-derived working only after the grace period and only if hooks did not', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    emitPty(title(`Working | ${THREAD}`))
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    // A hook moved the session to working meanwhile → the fallback stays quiet.
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()

    // Without hooks the fallback fires.
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    emitPty(title(`Ready | ${THREAD}`))
    emitPty(title(`Working | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.publishClaudeCliStatus).toHaveBeenCalledWith({
      sessionId: 'codex-session-1',
      status: 'working',
      metadata: { reason: 'codex_title_working' }
    })
  })
})

describe('Codex CLI turn end', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.handlers.clear()
    mocks.exitCallbacks.clear()
    mocks.dataCallbacks.clear()
    codexMocks.hookSubscribers.clear()
    codexMocks.turnWatchers.length = 0
    vi.clearAllMocks()
    __resetRuntimeRegistryForTests()

    setupDb()
    mocks.ptyService.has.mockReturnValue(false)
    mocks.getClaudeHookServer.mockResolvedValue({ port: 45678 })
    mocks.publishDesktopBackendEvent.mockResolvedValue(true)
    mocks.getLastClaudeCliStatus.mockReturnValue(undefined)
    codexMocks.findCodexRolloutByIdPrefix.mockReturnValue(null)
  })

  afterEach(async () => {
    await cleanupTerminals()
    vi.useRealTimers()
  })

  it('does not re-publish working from a spinner title once the Stop hook completed the turn and the title is Ready', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    // The turn is running: hooks already said working, the title streams spinner frames.
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    emitPty(title(`Working | ${THREAD} ⠋`))
    await vi.advanceTimersByTimeAsync(1_500)
    emitPty(title(`Working | ${THREAD} ⠙`))
    // The Stop hook completes the turn; the TUI paints Ready right after.
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    emitPty(title(`Ready | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
  })

  it('does not re-publish working from a spinner title when the Stop hook lands before the Ready title', async () => {
    setupDb(makeSession({ claude_session_id: THREAD }))
    await createClaudeCliTerminal('codex-session-1', {})
    mocks.publishClaudeCliStatus.mockClear()
    mocks.getLastClaudeCliStatus.mockReturnValue('working')
    emitPty(title(`Working | ${THREAD} ⠋`))
    mocks.getLastClaudeCliStatus.mockReturnValue('completed')
    for (const subscriber of codexMocks.hookSubscribers) {
      subscriber({
        cli: 'codex',
        sessionId: 'codex-session-1',
        hook: { hook_event_name: 'Stop', session_id: THREAD }
      })
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
    // A later Ready title neither completes nor reopens anything.
    emitPty(title(`Ready | ${THREAD}`))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.publishClaudeCliStatus).not.toHaveBeenCalled()
  })
})
