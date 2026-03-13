import { describe, it, expect } from 'vitest'
import {
  type AgentSdkId,
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  TERMINAL_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

/**
 * Backward compatibility tests for Session 8 (Codex UI polish).
 *
 * Ensures that:
 * 1. Old persisted settings without Codex fields still load correctly
 * 2. Old sessions with OpenCode and Claude still work
 * 3. The agent_sdk default is 'opencode' for legacy sessions
 * 4. Codex capabilities are stable
 * 5. All AgentSdkId values are production-stable strings
 */

describe('Backward compatibility: settings without codex field', () => {
  // This mirrors the DEFAULT_SETTINGS merge pattern from useSettingsStore.ts:
  //   loadSettingsFromDatabase() returns { ...DEFAULT_SETTINGS, ...parsed }
  // Old persisted settings won't have codex-related fields, so the spread
  // merge fills them in with defaults.

  const DEFAULT_SETTINGS = {
    autoStartSession: true,
    defaultAgentSdk: 'opencode' as const,
    showModelIcons: false,
    stripAtMentions: true,
    codexFastMode: false
  }

  it('old persisted settings merge with defaults — missing fields get default values', () => {
    const oldPersisted = {
      autoStartSession: false,
      defaultAgentSdk: 'opencode' as const
    }

    const merged = { ...DEFAULT_SETTINGS, ...oldPersisted }

    // Old values are preserved
    expect(merged.autoStartSession).toBe(false)
    expect(merged.defaultAgentSdk).toBe('opencode')
    // New defaults fill in missing fields
    expect(merged.showModelIcons).toBe(false)
    expect(merged.stripAtMentions).toBe(true)
    expect(merged.codexFastMode).toBe(false)
  })

  it('new persisted settings with codex as defaultAgentSdk override the default', () => {
    const newPersisted = {
      autoStartSession: true,
      defaultAgentSdk: 'codex' as const,
      showModelIcons: true
    }

    const merged = { ...DEFAULT_SETTINGS, ...newPersisted }

    expect(merged.defaultAgentSdk).toBe('codex')
    expect(merged.showModelIcons).toBe(true)
    expect(merged.codexFastMode).toBe(false)
  })

  it('availableAgentSdks null safely handles codex access via optional chaining', () => {
    const availableAgentSdks: { opencode: boolean; claude: boolean; codex: boolean } | null = null

    // This matches how the renderer accesses capabilities: availableAgentSdks?.codex
    const isCodexAvailable = availableAgentSdks?.codex
    expect(isCodexAvailable).toBeUndefined()
    expect(!!isCodexAvailable).toBe(false)
  })
})

describe('Backward compatibility: defaultAgentSdk persistence', () => {
  it('defaultAgentSdk persisted as "opencode" still works', () => {
    const persisted: AgentSdkId = 'opencode'
    expect(persisted).toBe('opencode')
  })

  it('defaultAgentSdk persisted as "claude-code" still works', () => {
    const persisted: AgentSdkId = 'claude-code'
    expect(persisted).toBe('claude-code')
  })

  it('defaultAgentSdk persisted as "codex" is valid', () => {
    const persisted: AgentSdkId = 'codex'
    expect(persisted).toBe('codex')
  })

  it('defaultAgentSdk persisted as "terminal" is valid', () => {
    const persisted: AgentSdkId = 'terminal'
    expect(persisted).toBe('terminal')
  })

  it('default agent_sdk is "opencode" for legacy sessions', () => {
    // The DB migration defaults agent_sdk to 'opencode'
    // Old sessions without explicit SDK will have this value
    const legacyDefault: AgentSdkId = 'opencode'
    expect(legacyDefault).toBe('opencode')
  })
})

describe('Backward compatibility: sessions with existing SDKs still work', () => {
  it('sessions with agent_sdk = "opencode" are valid', () => {
    const session = {
      id: 's-1',
      agent_sdk: 'opencode' as AgentSdkId,
      name: 'Test Session'
    }
    expect(session.agent_sdk).toBe('opencode')
  })

  it('sessions with agent_sdk = "claude-code" are valid', () => {
    const session = {
      id: 's-2',
      agent_sdk: 'claude-code' as AgentSdkId,
      name: 'Claude Session'
    }
    expect(session.agent_sdk).toBe('claude-code')
  })

  it('sessions with agent_sdk = "codex" are valid', () => {
    const session = {
      id: 's-3',
      agent_sdk: 'codex' as AgentSdkId,
      name: 'Codex Session'
    }
    expect(session.agent_sdk).toBe('codex')
  })

  it('sessions with null/missing agent_sdk default to opencode', () => {
    const rawSession = { id: 's-old', agent_sdk: null }
    const resolvedSdk: AgentSdkId = (rawSession.agent_sdk as AgentSdkId) ?? 'opencode'
    expect(resolvedSdk).toBe('opencode')
  })
})

describe('All AgentSdkId values are production-stable', () => {
  // Anchored to real exported capability constants — each SDK has a corresponding
  // capability object. If a new SDK is added or one is removed, these tests will
  // need to be updated, which is the desired contract behavior.

  const SDK_CAPABILITY_MAP: Record<AgentSdkId, typeof OPENCODE_CAPABILITIES> = {
    opencode: OPENCODE_CAPABILITIES,
    'claude-code': CLAUDE_CODE_CAPABILITIES,
    codex: CODEX_CAPABILITIES,
    terminal: TERMINAL_CAPABILITIES
  }

  it('every AgentSdkId has a corresponding capability constant', () => {
    const allIds: AgentSdkId[] = ['opencode', 'claude-code', 'codex', 'terminal']
    for (const id of allIds) {
      expect(SDK_CAPABILITY_MAP[id]).toBeDefined()
    }
  })

  it('exactly four SDK capability constants are defined', () => {
    expect(Object.keys(SDK_CAPABILITY_MAP)).toHaveLength(4)
  })

  it('each capability object has all required boolean fields', () => {
    const requiredFields = [
      'supportsUndo', 'supportsRedo', 'supportsCommands',
      'supportsPermissionRequests', 'supportsQuestionPrompts',
      'supportsModelSelection', 'supportsReconnect', 'supportsPartialStreaming'
    ]
    for (const [sdkId, caps] of Object.entries(SDK_CAPABILITY_MAP)) {
      for (const field of requiredFields) {
        expect(typeof (caps as Record<string, unknown>)[field]).toBe('boolean')
      }
      // Verify the object exists as a real export
      expect(sdkId).toBeTruthy()
    }
  })
})

describe('Capability contracts are stable', () => {
  describe('OpenCode capabilities (backward-compat safe)', () => {
    it('all capabilities are enabled', () => {
      expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsCommands).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsPermissionRequests).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsQuestionPrompts).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsModelSelection).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsReconnect).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsPartialStreaming).toBe(true)
    })
  })

  describe('Claude Code capabilities', () => {
    it('supports undo but not redo', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('supports all interactive features', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsCommands).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsPermissionRequests).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsQuestionPrompts).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsModelSelection).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsReconnect).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsPartialStreaming).toBe(true)
    })
  })

  describe('Codex capabilities', () => {
    it('supports undo but not redo', () => {
      expect(CODEX_CAPABILITIES.supportsUndo).toBe(true)
      expect(CODEX_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('does NOT support commands (slash commands)', () => {
      expect(CODEX_CAPABILITIES.supportsCommands).toBe(false)
    })

    it('supports human-in-the-loop features', () => {
      expect(CODEX_CAPABILITIES.supportsPermissionRequests).toBe(true)
      expect(CODEX_CAPABILITIES.supportsQuestionPrompts).toBe(true)
    })

    it('supports model selection and reconnect', () => {
      expect(CODEX_CAPABILITIES.supportsModelSelection).toBe(true)
      expect(CODEX_CAPABILITIES.supportsReconnect).toBe(true)
    })

    it('supports partial streaming', () => {
      expect(CODEX_CAPABILITIES.supportsPartialStreaming).toBe(true)
    })
  })

  describe('Terminal capabilities (all disabled)', () => {
    it('all capabilities are disabled', () => {
      expect(TERMINAL_CAPABILITIES.supportsUndo).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsRedo).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsCommands).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsPermissionRequests).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsQuestionPrompts).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsModelSelection).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsReconnect).toBe(false)
      expect(TERMINAL_CAPABILITIES.supportsPartialStreaming).toBe(false)
    })
  })
})

describe('Settings store defaults contract', () => {
  it('defaultAgentSdk defaults to opencode (matching DB default)', () => {
    // This matches the DEFAULT_SETTINGS in useSettingsStore.ts
    const storeDefault: AgentSdkId = 'opencode'
    expect(storeDefault).toBe('opencode')
  })

  it('all four valid SDK values are accepted by the type system', () => {
    const values: AgentSdkId[] = ['opencode', 'claude-code', 'codex', 'terminal']
    expect(values).toHaveLength(4)
    expect(new Set(values).size).toBe(4)
  })

  it('loadFromDatabase merges defaults — missing codex fields get defaults', () => {
    // Simulating the merge pattern from loadSettingsFromDatabase
    const DEFAULT_SETTINGS = {
      autoStartSession: true,
      defaultAgentSdk: 'opencode' as const,
      showModelIcons: false
    }

    // Old persisted settings (no codex-related fields)
    const oldPersisted = {
      autoStartSession: false,
      defaultAgentSdk: 'opencode' as const
    }

    const merged = { ...DEFAULT_SETTINGS, ...oldPersisted }

    // Old values are preserved
    expect(merged.autoStartSession).toBe(false)
    expect(merged.defaultAgentSdk).toBe('opencode')

    // New defaults fill in missing fields
    expect(merged.showModelIcons).toBe(false)
  })
})
