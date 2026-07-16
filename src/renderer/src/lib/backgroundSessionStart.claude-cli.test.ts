import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from './message-send-times'
import { startBackgroundSessionPrompt } from './backgroundSessionStart'

const terminalApiMocks = vi.hoisted(() => ({
  sendClaudeCliPrompt: vi.fn(),
  createClaudeCli: vi.fn(),
  startHivePromptTelemetry: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: terminalApiMocks.startHivePromptTelemetry
}))

// Seed the store with a single claude-code-cli session so findSessionModelSource
// resolves it. setState merges, so the store's methods stay intact.
function seedClaudeCliSession(): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([
      [
        'wt1',
        [
          {
            id: 's1',
            agent_sdk: 'claude-code-cli',
            model_provider_id: null,
            model_id: null,
            model_variant: null
          }
        ]
      ]
    ]),
    sessionsByConnection: new Map(),
    pendingMessages: new Map()
  } as never)
}

function mockSendClaudeCliPrompt(delivered: boolean): ReturnType<typeof vi.fn> {
  terminalApiMocks.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered } })
  return terminalApiMocks.sendClaudeCliPrompt
}

describe('startBackgroundSessionPrompt — claude-code-cli follow-up delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: starting the background PTY succeeds (used by the no-live-PTY path).
    terminalApiMocks.createClaudeCli.mockResolvedValue({ success: true, value: { success: true } })
    seedClaudeCliSession()
    messageSendTimes.delete('s1')
    userExplicitSendTimes.delete('s1')
    lastSendMode.delete('s1')
    useWorktreeStatusStore.getState().clearSessionStatus('s1')
  })

  it('delivers straight to the live PTY and does not queue when delivered', async () => {
    const sendClaudeCliPrompt = mockSendClaudeCliPrompt(true)

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(sendClaudeCliPrompt).toHaveBeenCalledWith('s1', 'follow-up question')
    expect(useSessionStore.getState().pendingMessages.get('s1')).toBeUndefined()
    expect(terminalApiMocks.startHivePromptTelemetry).not.toHaveBeenCalled()
  })

  it('records send times and working status when delivered so the ticket timer runs', async () => {
    mockSendClaudeCliPrompt(true)

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(userExplicitSendTimes.get('s1')).toBeTypeOf('number')
    expect(messageSendTimes.get('s1')).toBeTypeOf('number')
    expect(lastSendMode.get('s1')).toBe('build')
    expect(useWorktreeStatusStore.getState().sessionStatuses['s1']?.status).toBe('working')
  })

  it('starts the CLI PTY with the prompt when no live PTY exists (background handoff)', async () => {
    // A background-created session (autoFocus:false) has no view to mount and
    // spawn it, so the helper must start the PTY itself rather than just queue.
    const sendClaudeCliPrompt = mockSendClaudeCliPrompt(false)

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(sendClaudeCliPrompt).toHaveBeenCalledWith('s1', 'follow-up question')
    expect(terminalApiMocks.createClaudeCli).toHaveBeenCalledWith('s1', {
      pendingPrompt: 'follow-up question'
    })
    // Started, not left queued.
    expect(useSessionStore.getState().pendingMessages.get('s1')).toBeUndefined()
    expect(terminalApiMocks.startHivePromptTelemetry).not.toHaveBeenCalled()
  })

  it('falls back to queuing when starting the background CLI PTY fails', async () => {
    mockSendClaudeCliPrompt(false)
    terminalApiMocks.createClaudeCli.mockResolvedValue({
      success: true,
      value: { success: false, error: 'spawn failed' }
    })

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(terminalApiMocks.createClaudeCli).toHaveBeenCalled()
    expect(useSessionStore.getState().pendingMessages.get('s1')).toBe('follow-up question')
  })

  it('records send tracking and working status when it starts a background CLI session', async () => {
    // Starting the background handoff should run the ticket timer just like a
    // live-PTY delivery, so the session shows as working rather than idle.
    mockSendClaudeCliPrompt(false)

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(userExplicitSendTimes.get('s1')).toBeTypeOf('number')
    expect(messageSendTimes.get('s1')).toBeTypeOf('number')
    expect(lastSendMode.get('s1')).toBe('build')
    expect(useWorktreeStatusStore.getState().sessionStatuses['s1']?.status).toBe('working')
  })

  it('does not record send tracking or status when it only queues after a failed start', async () => {
    mockSendClaudeCliPrompt(false)
    terminalApiMocks.createClaudeCli.mockResolvedValue({
      success: true,
      value: { success: false, error: 'spawn failed' }
    })

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(userExplicitSendTimes.get('s1')).toBeUndefined()
    expect(messageSendTimes.get('s1')).toBeUndefined()
    expect(useWorktreeStatusStore.getState().sessionStatuses['s1']?.status).toBeUndefined()
  })
})
