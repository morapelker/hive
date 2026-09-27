import { describe, expect, it } from 'vitest'
import {
  AGENT_SDK_VALUES,
  getAgentSdkDisplayName,
  isAgentCli,
  isClaudeCli,
  isClaudeFamily,
  isCodexCli,
  isCodexFamily,
  isTerminalBacked,
  supportsGoalMode,
  toModelCatalogSdk
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
})
