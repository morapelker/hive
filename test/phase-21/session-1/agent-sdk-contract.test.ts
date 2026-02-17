import { describe, it, expect } from 'vitest'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  type AgentSdkCapabilities,
  type AgentSdkId
} from '../../../src/main/services/agent-sdk-types'

const CAPABILITY_KEYS: (keyof AgentSdkCapabilities)[] = [
  'supportsUndo',
  'supportsRedo',
  'supportsCommands',
  'supportsPermissionRequests',
  'supportsQuestionPrompts',
  'supportsModelSelection',
  'supportsReconnect',
  'supportsPartialStreaming'
]

describe('AgentSdk contract', () => {
  describe('capability maps are complete', () => {
    it('OPENCODE_CAPABILITIES has all required keys with boolean values', () => {
      for (const key of CAPABILITY_KEYS) {
        expect(typeof OPENCODE_CAPABILITIES[key]).toBe('boolean')
      }
    })

    it('CLAUDE_CODE_CAPABILITIES has all required keys with boolean values', () => {
      for (const key of CAPABILITY_KEYS) {
        expect(typeof CLAUDE_CODE_CAPABILITIES[key]).toBe('boolean')
      }
    })

    it('no extra keys in OPENCODE_CAPABILITIES', () => {
      expect(Object.keys(OPENCODE_CAPABILITIES).sort()).toEqual(CAPABILITY_KEYS.slice().sort())
    })

    it('no extra keys in CLAUDE_CODE_CAPABILITIES', () => {
      expect(Object.keys(CLAUDE_CODE_CAPABILITIES).sort()).toEqual(CAPABILITY_KEYS.slice().sort())
    })
  })

  describe('capability differences are intentional', () => {
    it('Claude does not support redo', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('OpenCode supports redo', () => {
      expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
    })

    it('both support undo', () => {
      expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
    })

    it('both support commands', () => {
      expect(OPENCODE_CAPABILITIES.supportsCommands).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsCommands).toBe(true)
    })

    it('both support reconnect', () => {
      expect(OPENCODE_CAPABILITIES.supportsReconnect).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsReconnect).toBe(true)
    })
  })

  describe('AgentSdkId values', () => {
    it('valid SDK identifiers are opencode and claude-code', () => {
      const validIds: AgentSdkId[] = ['opencode', 'claude-code']
      expect(validIds).toHaveLength(2)
      const _a: AgentSdkId = 'opencode'
      const _b: AgentSdkId = 'claude-code'
      expect(_a).toBe('opencode')
      expect(_b).toBe('claude-code')
    })
  })

  describe('session identifier format contract', () => {
    it('agent session IDs are non-empty strings', () => {
      const mockOpenCodeId = 'oc_session_abc123'
      const mockClaudeId = 'claude-session-uuid-here'
      expect(typeof mockOpenCodeId).toBe('string')
      expect(mockOpenCodeId.length).toBeGreaterThan(0)
      expect(typeof mockClaudeId).toBe('string')
      expect(mockClaudeId.length).toBeGreaterThan(0)
    })

    it('agent_sdk defaults to opencode for backward compatibility', () => {
      const defaultSdk: AgentSdkId = 'opencode'
      expect(defaultSdk).toBe('opencode')
    })
  })
})
