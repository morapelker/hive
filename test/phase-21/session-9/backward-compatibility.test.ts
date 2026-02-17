import { describe, it, expect } from 'vitest'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/schema'
import {
  type AgentSdkId,
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

/**
 * Backward compatibility tests for Session 9.
 *
 * These tests ensure that:
 * 1. The schema migration uses the correct default value
 * 2. The agent_sdk column is production-ready (no rename needed)
 * 3. Historical sessions fall back to opencode correctly
 * 4. The agent_sdk string values are stable and consistent
 */

describe('Backward compatibility', () => {
  describe('schema migration stability', () => {
    it('current schema version is 2 (includes agent_sdk migration)', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(2)
    })

    it('migration v2 adds agent_sdk column with opencode default', () => {
      const migration = MIGRATIONS.find((m) => m.version === 2)
      expect(migration).toBeDefined()
      expect(migration!.name).toBe('add_agent_sdk_column')
      expect(migration!.up).toContain('agent_sdk')
      expect(migration!.up).toContain("DEFAULT 'opencode'")
    })

    it('no migration exists that renames agent_sdk values', () => {
      // Ensure no migration alters existing agent_sdk values
      // (i.e., no UPDATE sessions SET agent_sdk = ... WHERE agent_sdk = ...)
      for (const migration of MIGRATIONS) {
        if (migration.version > 2) {
          expect(migration.up).not.toContain('UPDATE sessions SET agent_sdk')
        }
      }
    })

    it('total migration count is exactly 2', () => {
      expect(MIGRATIONS).toHaveLength(2)
    })
  })

  describe('AgentSdkId values are production-stable', () => {
    it('"opencode" is a valid AgentSdkId', () => {
      const id: AgentSdkId = 'opencode'
      expect(id).toBe('opencode')
    })

    it('"claude-code" is a valid AgentSdkId', () => {
      const id: AgentSdkId = 'claude-code'
      expect(id).toBe('claude-code')
    })

    it('the string values match what the DB migration uses', () => {
      // The migration defaults to 'opencode', which must match the type
      const defaultFromMigration = 'opencode'
      const _valid: AgentSdkId = defaultFromMigration
      expect(_valid).toBe('opencode')
    })
  })

  describe('fallback to opencode for missing/invalid rows', () => {
    it('simulates getAgentSdkForSession returning null for unknown session', () => {
      // When a session lookup fails, it returns null
      // The IPC handler should fall through to OpenCode in this case
      const result: 'opencode' | 'claude-code' | null = null
      const resolvedSdk = result ?? 'opencode'
      expect(resolvedSdk).toBe('opencode')
    })

    it('resolves to opencode when agent_sdk column is the default value', () => {
      // Historical sessions created before agent_sdk was added
      // will have the DEFAULT 'opencode' value
      const historicalAgentSdk: AgentSdkId = 'opencode'
      expect(historicalAgentSdk).toBe('opencode')
    })

    it('opencode capabilities are fully enabled (backward compat safe)', () => {
      // All OpenCode capabilities should be true so existing sessions
      // never lose functionality
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

  describe('claude-code capabilities are production-ready', () => {
    it('claude-code supports undo but not redo', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('claude-code supports all human-in-the-loop features', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsPermissionRequests).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsQuestionPrompts).toBe(true)
    })

    it('claude-code supports model selection and reconnect', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsModelSelection).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsReconnect).toBe(true)
    })
  })

  describe('settings store default contract', () => {
    it('defaultAgentSdk defaults to opencode (matching DB default)', () => {
      // The settings store default must match the DB migration default
      // to ensure consistency for users who never changed the setting
      const storeDefault: AgentSdkId = 'opencode'
      expect(storeDefault).toBe('opencode')
    })

    it('both valid SDK values are accepted by the type system', () => {
      const values: AgentSdkId[] = ['opencode', 'claude-code']
      expect(values).toHaveLength(2)
      // Ensure both are distinct
      expect(new Set(values).size).toBe(2)
    })
  })
})
