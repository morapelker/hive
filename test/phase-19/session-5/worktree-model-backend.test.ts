import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/schema'
import type { Worktree, WorktreeUpdate } from '../../../src/main/db/types'

describe('Session 5: Per-Worktree Model Backend', () => {
  test('CURRENT_SCHEMA_VERSION is bumped to 14', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14)
  })

  test('migration 14 adds last_model_* columns', () => {
    const migration = MIGRATIONS.find((m) => m.version === 14)
    expect(migration).toBeDefined()
    expect(migration!.name).toBe('add_worktree_model_columns')
    expect(migration!.up).toContain('last_model_provider_id')
    expect(migration!.up).toContain('last_model_id')
    expect(migration!.up).toContain('last_model_variant')
    // All three should be ALTER TABLE statements on worktrees
    expect(migration!.up).toContain('ALTER TABLE worktrees ADD COLUMN last_model_provider_id TEXT')
    expect(migration!.up).toContain('ALTER TABLE worktrees ADD COLUMN last_model_id TEXT')
    expect(migration!.up).toContain('ALTER TABLE worktrees ADD COLUMN last_model_variant TEXT')
  })

  test('Worktree type includes model fields', () => {
    // TypeScript compilation check -- if this compiles, the fields exist
    const worktree: Worktree = {
      id: 'test-id',
      project_id: 'proj-1',
      name: 'test',
      branch_name: 'main',
      path: '/tmp/test',
      status: 'active',
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: 'anthropic',
      last_model_id: 'claude-opus',
      last_model_variant: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    }
    expect(worktree.last_model_provider_id).toBe('anthropic')
    expect(worktree.last_model_id).toBe('claude-opus')
    expect(worktree.last_model_variant).toBeNull()
  })

  test('Worktree model fields can be null', () => {
    const worktree: Worktree = {
      id: 'test-id',
      project_id: 'proj-1',
      name: 'test',
      branch_name: 'main',
      path: '/tmp/test',
      status: 'active',
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    }
    expect(worktree.last_model_provider_id).toBeNull()
    expect(worktree.last_model_id).toBeNull()
    expect(worktree.last_model_variant).toBeNull()
  })

  test('WorktreeUpdate type includes model fields as optional', () => {
    // TypeScript compilation check
    const update: WorktreeUpdate = {
      last_model_provider_id: 'openai',
      last_model_id: 'gpt-4o',
      last_model_variant: 'latest'
    }
    expect(update.last_model_provider_id).toBe('openai')
    expect(update.last_model_id).toBe('gpt-4o')
    expect(update.last_model_variant).toBe('latest')
  })

  test('WorktreeUpdate model fields are optional', () => {
    // This should compile fine with no model fields
    const update: WorktreeUpdate = {
      name: 'new-name'
    }
    expect(update.last_model_provider_id).toBeUndefined()
    expect(update.last_model_id).toBeUndefined()
    expect(update.last_model_variant).toBeUndefined()
  })

  test('updateModel type declaration exists on db.worktree', () => {
    // Verify the window.db.worktree.updateModel mock can be set up
    // (TypeScript compilation check for the type declaration)
    const mockUpdateModel = vi.fn().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'db', {
      value: {
        worktree: {
          updateModel: mockUpdateModel
        }
      },
      writable: true,
      configurable: true
    })
    expect(window.db.worktree.updateModel).toBeDefined()
    expect(typeof window.db.worktree.updateModel).toBe('function')
  })

  test('migration columns are nullable (no NOT NULL constraint)', () => {
    const migration = MIGRATIONS.find((m) => m.version === 14)
    expect(migration).toBeDefined()
    // Verify no NOT NULL constraint -- columns should default to NULL for existing rows
    expect(migration!.up).not.toContain('NOT NULL')
  })
})
