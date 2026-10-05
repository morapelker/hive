import { describe, expect, it } from 'vitest'
import {
  AGENT_SDK_VALUES,
  getAgentSdkDisplayName,
  isAgentCli,
  isClaudeCli,
  isClaudeFamily,
  isCodexCli,
  isCodexFamily,
  isShellCommandSession,
  isTerminalBacked,
  SHELL_COMMAND_SESSION_TYPE,
  supportsGoalMode,
  toModelCatalogSdk,
  usesSessionTerminalPortal
} from './agent-sdk'

describe('agent-sdk predicates', () => {
  it('lists codex-cli as an SDK', () => {
    expect(AGENT_SDK_VALUES).toContain('codex-cli')
  })

  it('classifies the terminal-backed CLIs', () => {
    expect(isClaudeCli('claude-code-cli')).toBe(true)
    expect(isClaudeCli('codex-cli')).toBe(false)
    expect(isCodexCli('codex-cli')).toBe(true)
    expect(isCodexCli('codex')).toBe(false)
    expect(isAgentCli('claude-code-cli')).toBe(true)
    expect(isAgentCli('codex-cli')).toBe(true)
    expect(isAgentCli('codex')).toBe(false)
    expect(isAgentCli('terminal')).toBe(false)
    expect(isTerminalBacked('codex-cli')).toBe(true)
    expect(isTerminalBacked('terminal')).toBe(true)
    expect(isTerminalBacked('opencode')).toBe(false)
  })

  it('groups families and catalogs', () => {
    expect(isClaudeFamily('codex-cli')).toBe(false)
    expect(isCodexFamily('codex')).toBe(true)
    expect(isCodexFamily('codex-cli')).toBe(true)
    expect(toModelCatalogSdk('codex-cli')).toBe('codex')
    expect(toModelCatalogSdk('claude-code-cli')).toBe('claude-code')
    expect(toModelCatalogSdk('opencode')).toBe('opencode')
    expect(toModelCatalogSdk(null)).toBeNull()
  })

  it('supports goal mode for both codex variants and the claude CLI', () => {
    expect(supportsGoalMode('codex-cli')).toBe(true)
    expect(supportsGoalMode('codex')).toBe(true)
    expect(supportsGoalMode('claude-code-cli')).toBe(true)
    expect(supportsGoalMode('claude-code')).toBe(false)
  })

  it('names SDKs for the UI', () => {
    expect(getAgentSdkDisplayName('codex-cli')).toBe('Codex (CLI)')
    expect(getAgentSdkDisplayName('claude-code-cli')).toBe('Claude Code (CLI)')
    expect(getAgentSdkDisplayName(null)).toBe('Agent')
  })

  it('tells shell-command sessions apart from plain terminals', () => {
    expect(SHELL_COMMAND_SESSION_TYPE).toBe('shell-command')
    expect(isShellCommandSession({ agent_sdk: 'terminal', session_type: 'shell-command' })).toBe(
      true
    )
    expect(isShellCommandSession({ agent_sdk: 'terminal', session_type: 'default' })).toBe(false)
    expect(isShellCommandSession({ agent_sdk: 'terminal' })).toBe(false)
    expect(isShellCommandSession({ agent_sdk: 'terminal', session_type: null })).toBe(false)
    expect(
      isShellCommandSession({ agent_sdk: 'claude-code-cli', session_type: 'shell-command' })
    ).toBe(false)
    expect(isShellCommandSession({ session_type: 'shell-command' })).toBe(false)
    expect(isShellCommandSession(null)).toBe(false)
    expect(isShellCommandSession(undefined)).toBe(false)

    // A shell command is still a terminal for every "terminal means no AI" guard.
    expect(isTerminalBacked('terminal')).toBe(true)
    expect(isAgentCli('terminal')).toBe(false)
  })

  it('routes the agent CLIs and shell commands through the session terminal portal', () => {
    expect(usesSessionTerminalPortal({ agent_sdk: 'claude-code-cli' })).toBe(true)
    expect(usesSessionTerminalPortal({ agent_sdk: 'codex-cli', session_type: 'default' })).toBe(
      true
    )
    expect(
      usesSessionTerminalPortal({ agent_sdk: 'terminal', session_type: 'shell-command' })
    ).toBe(true)
    expect(usesSessionTerminalPortal({ agent_sdk: 'terminal', session_type: 'default' })).toBe(
      false
    )
    expect(usesSessionTerminalPortal({ agent_sdk: 'terminal' })).toBe(false)
    expect(usesSessionTerminalPortal({ agent_sdk: 'opencode' })).toBe(false)
    expect(
      usesSessionTerminalPortal({ agent_sdk: 'opencode', session_type: 'shell-command' })
    ).toBe(false)
    expect(usesSessionTerminalPortal(null)).toBe(false)
    expect(usesSessionTerminalPortal(undefined)).toBe(false)
  })
})
