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
})
