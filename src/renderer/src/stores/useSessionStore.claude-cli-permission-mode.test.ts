import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  useSessionStore,
  syncClaudeCliPermissionModeIfNeeded,
  CLAUDE_CLI_ENTER_PLAN_MODE
} from '@/stores/useSessionStore'

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

describe('syncClaudeCliPermissionModeIfNeeded — claude-code-cli', () => {
  beforeEach(() => {
    seedSession('claude-code-cli')
  })

  it("enters plan mode with claude's /plan command after clearing the input line, in one write", () => {
    // Shift+Tab cycles bypass → auto → default → accept-edits → plan (claude 2.1.317), so a
    // fixed press count cannot reach plan; two presses from a build session landed on default.
    // The command types into the input box, so a half-typed draft there is cleared first
    // (Ctrl+U) rather than submitted with `/plan` appended.
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'plan')
    expect(CLAUDE_CLI_ENTER_PLAN_MODE).toBe('\x15/plan\r')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', '\x15/plan\r')
    expect(write).not.toHaveBeenCalledWith('s1', SHIFT_TAB)
  })

  it('sends one Shift+Tab press leaving plan mode (plan → bypass permissions)', () => {
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'plan', 'build')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', SHIFT_TAB)
  })

  it('treats super-plan as plan-like (/plan to enter, one press to leave)', () => {
    const enter = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'super-plan')
    expect(enter).toHaveBeenCalledTimes(1)
    expect(enter).toHaveBeenCalledWith('s1', CLAUDE_CLI_ENTER_PLAN_MODE)

    const leave = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'super-plan', 'build')
    expect(leave).toHaveBeenCalledTimes(1)
    expect(leave).toHaveBeenCalledWith('s1', SHIFT_TAB)
  })

  it('enters plan mode from super-build too', () => {
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'super-build', 'plan')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', CLAUDE_CLI_ENTER_PLAN_MODE)
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

describe('setSessionMode — a plan follow-up on a build session', () => {
  beforeEach(() => {
    seedSession('claude-code-cli')
    useSessionStore.setState({ modeBySession: new Map([['s1', 'build']]) } as never)
  })

  it('puts the CLI in plan mode before the follow-up is pasted', async () => {
    const write = mockWrite()
    await useSessionStore.getState().setSessionMode('s1', 'plan')
    expect(write.mock.calls).toEqual([['s1', CLAUDE_CLI_ENTER_PLAN_MODE]])
    expect(useSessionStore.getState().modeBySession.get('s1')).toBe('plan')
  })
})

describe('setSessionMode — syncCliPermissionMode option', () => {
  beforeEach(() => {
    seedSession('claude-code-cli')
    useSessionStore.setState({ modeBySession: new Map([['s1', 'plan']]) } as never)
  })

  it('sends the PTY sync by default when leaving plan mode', async () => {
    const write = mockWrite()
    await useSessionStore.getState().setSessionMode('s1', 'build')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', SHIFT_TAB)
  })

  it('skips the PTY sync when syncCliPermissionMode is false but still updates the mode', async () => {
    const write = mockWrite()
    await useSessionStore.getState().setSessionMode('s1', 'build', { syncCliPermissionMode: false })
    expect(write).not.toHaveBeenCalled()
    expect(useSessionStore.getState().modeBySession.get('s1')).toBe('build')
  })
})

describe('syncClaudeCliPermissionModeIfNeeded — codex-cli', () => {
  beforeEach(() => {
    seedSession('codex-cli')
  })

  it('sends a single Shift+Tab in either direction (codex has exactly Default ↔ Plan)', () => {
    const enter = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'plan')
    expect(enter).toHaveBeenCalledTimes(1)
    expect(enter).toHaveBeenCalledWith('s1', SHIFT_TAB)

    const leave = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'super-plan', 'build')
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('does nothing for non-CLI sessions', () => {
    seedSession('codex')
    const write = mockWrite()
    syncClaudeCliPermissionModeIfNeeded(useSessionStore.getState(), 's1', 'build', 'plan')
    expect(write).not.toHaveBeenCalled()
  })
})
