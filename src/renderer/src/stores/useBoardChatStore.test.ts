import { describe, expect, it } from 'vitest'
import { resolveBoardChatAgentSdk } from './useBoardChatStore'

describe('resolveBoardChatAgentSdk', () => {
  // The board assistant is a streaming OpenCode-style session with no PTY, so
  // terminal-backed CLI SDKs must be coerced to their streaming sibling before
  // being persisted as the session agent_sdk — otherwise later prompts fail the
  // isCliAgentSdk guard in promptOpenCodeSession.
  it('coerces terminal-backed CLI SDKs to their streaming implementer', () => {
    expect(resolveBoardChatAgentSdk('codex-cli')).toBe('codex')
    expect(resolveBoardChatAgentSdk('claude-code-cli')).toBe('claude-code')
    expect(resolveBoardChatAgentSdk('terminal')).toBe('opencode')
  })

  it('passes streaming SDKs through unchanged (idempotent)', () => {
    expect(resolveBoardChatAgentSdk('opencode')).toBe('opencode')
    expect(resolveBoardChatAgentSdk('claude-code')).toBe('claude-code')
    expect(resolveBoardChatAgentSdk('codex')).toBe('codex')
  })

  it('defaults to opencode for null / undefined', () => {
    expect(resolveBoardChatAgentSdk(null)).toBe('opencode')
    expect(resolveBoardChatAgentSdk(undefined)).toBe('opencode')
  })

  it('falls back to opencode when the coerced streaming provider is unavailable', () => {
    // codex build with CLI/hooks but no app-server (codex:false, codexCli:true):
    // codex-cli (and a direct codex) must not be persisted, since the codex
    // implementer's startSession() would throw.
    const noCodex = { opencode: true, claude: true, codex: false, codexCli: true }
    expect(resolveBoardChatAgentSdk('codex-cli', noCodex)).toBe('opencode')
    expect(resolveBoardChatAgentSdk('codex', noCodex)).toBe('opencode')
    // claude-code missing → claude-code-cli / claude-code also fall back.
    const noClaude = { opencode: true, claude: false, codex: true }
    expect(resolveBoardChatAgentSdk('claude-code-cli', noClaude)).toBe('opencode')
    expect(resolveBoardChatAgentSdk('claude-code', noClaude)).toBe('opencode')
  })

  it('still coerces to the streaming sibling when the provider IS available', () => {
    const all = { opencode: true, claude: true, codex: true, codexCli: true }
    expect(resolveBoardChatAgentSdk('codex-cli', all)).toBe('codex')
    expect(resolveBoardChatAgentSdk('claude-code-cli', all)).toBe('claude-code')
  })

  it('stays optimistic when availability is unknown (null)', () => {
    expect(resolveBoardChatAgentSdk('codex-cli', null)).toBe('codex')
    expect(resolveBoardChatAgentSdk('codex-cli', undefined)).toBe('codex')
  })
})
