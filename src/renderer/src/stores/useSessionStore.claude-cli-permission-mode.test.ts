import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSessionStore, syncClaudeCliPermissionModeIfNeeded } from '@/stores/useSessionStore'

const SHIFT_TAB = '\u001b[Z'

const terminalApiMocks = vi.hoisted(() => ({
  write: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

function seedSession(agentSdk: string): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([['wt1', [{ id: 's1', agent_sdk: agentSdk }]]]),
    sessionsByConnection: new Map(),
    boardAssistantByProject: new Map(),
    orphanedSessions: new Map()
  } as never)
}

function mockWrite(): ReturnType<typeof vi.fn> {
  terminalApiMocks.write.mockClear()
  return terminalApiMocks.write
}

describe('syncClaudeCliPermissionModeIfNeeded — Shift+Tab press counts', () => {
  beforeEach(() => {
    seedSession('claude-code-cli')
  })

  it('sends two Shift+Tab presses entering plan mode (normal → accept-edits → plan)', () => {
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'plan')
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(1, 's1', SHIFT_TAB)
    expect(write).toHaveBeenNthCalledWith(2, 's1', SHIFT_TAB)
  })

  it('sends one Shift+Tab press leaving plan mode (plan → normal)', () => {
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'plan', 'build')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', SHIFT_TAB)
  })

  it('treats super-plan as plan-like (two presses to enter, one to leave)', () => {
    const enter = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'super-plan')
    expect(enter).toHaveBeenCalledTimes(2)

    const leave = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'super-plan', 'build')
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the plan-like boundary is not crossed (plan → super-plan)', () => {
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'plan', 'super-plan')
    expect(write).not.toHaveBeenCalled()
  })

  it('does nothing for non-claude-code-cli sessions', () => {
    seedSession('opencode')
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'plan')
    expect(write).not.toHaveBeenCalled()
  })
})
