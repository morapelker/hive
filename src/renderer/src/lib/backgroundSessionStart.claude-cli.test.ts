import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from './message-send-times'
import { startBackgroundSessionPrompt } from './backgroundSessionStart'

const terminalApiMocks = vi.hoisted(() => ({
  sendClaudeCliPrompt: vi.fn(),
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

  it('queues the prompt for the next spawn when no live PTY exists', async () => {
    const sendClaudeCliPrompt = mockSendClaudeCliPrompt(false)

    await startBackgroundSessionPrompt({
      worktreePath: '/repo',
      sessionId: 's1',
      prompt: 'follow-up question',
      bumpTarget: {}
    })

    expect(sendClaudeCliPrompt).toHaveBeenCalledWith('s1', 'follow-up question')
    expect(useSessionStore.getState().pendingMessages.get('s1')).toBe('follow-up question')
    expect(terminalApiMocks.startHivePromptTelemetry).not.toHaveBeenCalled()
  })

  it('does not record send times or working status when the prompt was only queued', async () => {
    mockSendClaudeCliPrompt(false)

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
