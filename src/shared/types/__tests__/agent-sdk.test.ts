import { describe, expect, it } from 'vitest'
import {
  AGENT_SDK_VALUES,
  isClaudeCli,
  isClaudeFamily,
  isCliAgentSdk,
  isCodexCli,
  isCodexFamily,
  isTerminalBacked,
  supportsGoalMode,
  toModelCatalogSdk
} from '../agent-sdk'

describe('agent-sdk predicates', () => {
  it('exposes codex-cli as a canonical SDK value', () => {
    expect(AGENT_SDK_VALUES).toContain('codex-cli')
  })

  it('isClaudeCli / isCodexCli identify only their exact CLI variant', () => {
    expect(isClaudeCli('claude-code-cli')).toBe(true)
    expect(isClaudeCli('codex-cli')).toBe(false)
    expect(isCodexCli('codex-cli')).toBe(true)
    expect(isCodexCli('codex')).toBe(false)
    expect(isCodexCli('claude-code-cli')).toBe(false)
  })

  it('isCliAgentSdk covers both terminal-backed CLI agents (anchors PTY prompt routing)', () => {
    // Telegram forwarding + the in-app terminal follow-up path both inject
    // prompts straight into the PTY for these, since neither has an SDK
    // implementer to route through.
    expect(isCliAgentSdk('claude-code-cli')).toBe(true)
    expect(isCliAgentSdk('codex-cli')).toBe(true)
    expect(isCliAgentSdk('codex')).toBe(false)
    expect(isCliAgentSdk('claude-code')).toBe(false)
    expect(isCliAgentSdk('terminal')).toBe(false)
    expect(isCliAgentSdk('opencode')).toBe(false)
  })

  it('isTerminalBacked adds the bare terminal to the CLI agents', () => {
    expect(isTerminalBacked('terminal')).toBe(true)
    expect(isTerminalBacked('codex-cli')).toBe(true)
    expect(isTerminalBacked('claude-code-cli')).toBe(true)
    expect(isTerminalBacked('codex')).toBe(false)
    expect(isTerminalBacked('opencode')).toBe(false)
  })

  it('family predicates group each SDK with its CLI sibling', () => {
    expect(isClaudeFamily('claude-code')).toBe(true)
    expect(isClaudeFamily('claude-code-cli')).toBe(true)
    expect(isClaudeFamily('codex-cli')).toBe(false)

    expect(isCodexFamily('codex')).toBe(true)
    expect(isCodexFamily('codex-cli')).toBe(true)
    expect(isCodexFamily('claude-code-cli')).toBe(false)
  })

  it('supportsGoalMode includes both codex variants and the claude CLI', () => {
    expect(supportsGoalMode('codex')).toBe(true)
    expect(supportsGoalMode('codex-cli')).toBe(true)
    expect(supportsGoalMode('claude-code-cli')).toBe(true)
    expect(supportsGoalMode('claude-code')).toBe(false)
    expect(supportsGoalMode('opencode')).toBe(false)
  })

  it('toModelCatalogSdk resolves the CLI variants to their catalog sibling', () => {
    expect(toModelCatalogSdk('codex-cli')).toBe('codex')
    expect(toModelCatalogSdk('claude-code-cli')).toBe('claude-code')
    expect(toModelCatalogSdk('codex')).toBe('codex')
    expect(toModelCatalogSdk(null)).toBeNull()
    expect(toModelCatalogSdk(undefined)).toBeUndefined()
  })

  it('all predicates tolerate null / undefined / unknown strings', () => {
    for (const sdk of [null, undefined, 'some-future-sdk']) {
      expect(isCliAgentSdk(sdk)).toBe(false)
      expect(isCodexFamily(sdk)).toBe(false)
      expect(isTerminalBacked(sdk)).toBe(false)
      expect(supportsGoalMode(sdk)).toBe(false)
    }
  })
})
