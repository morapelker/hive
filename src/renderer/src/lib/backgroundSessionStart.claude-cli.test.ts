import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSessionStore } from '@/stores/useSessionStore'
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
})
