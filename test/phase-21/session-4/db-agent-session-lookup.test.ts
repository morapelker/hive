import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { DatabaseService } from '../../../src/main/db/database'

describe('DatabaseService.getAgentSdkForSession', () => {
  let db: DatabaseService

  beforeEach(() => {
    db = new DatabaseService(':memory:')
    db.init()
  })

  it('returns "opencode" for an OpenCode session', () => {
    const project = db.createProject({ name: 'P', path: '/p' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/p',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'test',
      opencode_session_id: 'opc-123',
      agent_sdk: 'opencode'
    })

    const result = db.getAgentSdkForSession('opc-123')
    expect(result).toBe('opencode')
  })

  it('returns "claude-code" for a Claude session', () => {
    const project = db.createProject({ name: 'P', path: '/p' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/p',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'test',
      opencode_session_id: 'pending::abc-123',
      agent_sdk: 'claude-code'
    })

    const result = db.getAgentSdkForSession('pending::abc-123')
    expect(result).toBe('claude-code')
  })

  it('returns null when no session matches', () => {
    const result = db.getAgentSdkForSession('nonexistent')
    expect(result).toBeNull()
  })
})
