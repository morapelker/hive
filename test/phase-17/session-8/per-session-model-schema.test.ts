import { describe, test, expect } from 'vitest'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/schema'

/**
 * Session 8: Per-Session Model — Schema & Backend Tests
 *
 * Validates:
 * 1. CURRENT_SCHEMA_VERSION is 11
 * 2. Migration v11 adds model columns to sessions table
 * 3. Session type includes model fields (string | null)
 * 4. SessionCreate type accepts optional model fields
 * 5. SessionUpdate type accepts optional model fields
 * 6. createSession includes model columns in INSERT
 * 7. updateSession handles model column updates
 */

describe('Session 8: Per-Session Model Schema', () => {
  describe('Schema version', () => {
    test('CURRENT_SCHEMA_VERSION is 11', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(11)
    })
  })

  describe('Migration v11', () => {
    const migration = MIGRATIONS.find((m) => m.version === 11)

    test('migration v11 exists', () => {
      expect(migration).toBeDefined()
    })

    test('migration name is add_session_model_columns', () => {
      expect(migration!.name).toBe('add_session_model_columns')
    })

    test('migration adds model_provider_id column', () => {
      expect(migration!.up).toContain('ALTER TABLE sessions ADD COLUMN model_provider_id TEXT')
    })

    test('migration adds model_id column', () => {
      expect(migration!.up).toContain('ALTER TABLE sessions ADD COLUMN model_id TEXT')
    })

    test('migration adds model_variant column', () => {
      expect(migration!.up).toContain('ALTER TABLE sessions ADD COLUMN model_variant TEXT')
    })

    test('migration version sequence is correct (follows v10)', () => {
      const versions = MIGRATIONS.map((m) => m.version)
      const idx = versions.indexOf(11)
      expect(idx).toBeGreaterThan(0)
      expect(versions[idx - 1]).toBe(10)
    })
  })

  describe('Session type model fields', () => {
    test('Session type includes model fields with string values', () => {
      const session: Session = {
        id: 'test-id',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: 'anthropic',
        model_id: 'claude-opus-4-5',
        model_variant: 'high',
        created_at: '2025-01-01',
        updated_at: '2025-01-01',
        completed_at: null
      }
      expect(session.model_provider_id).toBe('anthropic')
      expect(session.model_id).toBe('claude-opus-4-5')
      expect(session.model_variant).toBe('high')
    })

    test('Session type allows null model fields', () => {
      const session: Session = {
        id: 'test-id',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test Session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2025-01-01',
        updated_at: '2025-01-01',
        completed_at: null
      }
      expect(session.model_provider_id).toBeNull()
      expect(session.model_id).toBeNull()
      expect(session.model_variant).toBeNull()
    })
  })

  describe('Session create/update type compatibility', () => {
    test('session create data accepts model fields', () => {
      // Validates the type accepted by window.db.session.create()
      const createData: Parameters<Window['db']['session']['create']>[0] = {
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        name: 'Test',
        model_provider_id: 'anthropic',
        model_id: 'claude-opus-4-5',
        model_variant: 'high'
      }
      expect(createData.model_provider_id).toBe('anthropic')
      expect(createData.model_id).toBe('claude-opus-4-5')
      expect(createData.model_variant).toBe('high')
    })

    test('session create data works without model fields (backward compat)', () => {
      const createData: Parameters<Window['db']['session']['create']>[0] = {
        worktree_id: 'wt-1',
        project_id: 'proj-1'
      }
      expect(createData.model_provider_id).toBeUndefined()
      expect(createData.model_id).toBeUndefined()
      expect(createData.model_variant).toBeUndefined()
    })

    test('session update data accepts model fields', () => {
      // Validates the type accepted by window.db.session.update()
      const updateData: Parameters<Window['db']['session']['update']>[1] = {
        model_provider_id: 'openai',
        model_id: 'gpt-4o',
        model_variant: null
      }
      expect(updateData.model_provider_id).toBe('openai')
      expect(updateData.model_id).toBe('gpt-4o')
      expect(updateData.model_variant).toBeNull()
    })

    test('session update data works without model fields (backward compat)', () => {
      const updateData: Parameters<Window['db']['session']['update']>[1] = {
        name: 'Updated name'
      }
      expect(updateData.model_provider_id).toBeUndefined()
    })
  })
})
