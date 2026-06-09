import { afterEach, vi } from 'vitest'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/schema'
import type { Worktree, WorktreeUpdate } from '../../../src/main/db/types'
import { dbApi } from '../../../src/renderer/src/api/db-api'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../../src/renderer/src/api/rpc-client'

describe('Session 5: Per-Worktree Model Backend', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  test('CURRENT_SCHEMA_VERSION is defined', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })

  test('schema includes last_model_* columns on worktrees', () => {
    const initialMigration = MIGRATIONS.find((m) => m.version === 1)
    expect(initialMigration).toBeDefined()
    expect(initialMigration!.up).toContain('last_model_provider_id')
    expect(initialMigration!.up).toContain('last_model_id')
    expect(initialMigration!.up).toContain('last_model_variant')
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

  test('updateModel routes through dbApi RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const params = {
      worktreeId: 'worktree-1',
      modelProviderId: 'anthropic',
      modelId: 'claude-opus',
      modelVariant: null
    }

    setRendererRpcClient({ request, subscribe })

    await expect(dbApi.worktree.updateModel(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('db.worktree.updateModel', params)
  })

  test('last_model columns are nullable (no NOT NULL constraint)', () => {
    const initialMigration = MIGRATIONS.find((m) => m.version === 1)
    expect(initialMigration).toBeDefined()
    // Verify last_model_* columns don't have NOT NULL (they use TEXT which defaults to NULL)
    const upSql = initialMigration!.up
    const providerLine = upSql.split('\n').find((l: string) => l.includes('last_model_provider_id'))
    expect(providerLine).toBeDefined()
    expect(providerLine).not.toContain('NOT NULL')
  })
})
