import { describe, expect, it, vi } from 'vitest'
import { createProjectWithDefaultWorktree } from './project-ops'
import type { Project, Worktree } from '../db/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

const project: Project = {
  id: 'project-1',
  name: 'repo',
  path: '/repo',
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z'
}

describe('createProjectWithDefaultWorktree', () => {
  it('creates the project and default placeholder worktree together', () => {
    const createProject = vi.fn(() => project)
    const createWorktree = vi.fn(
      (data): Worktree => ({
        id: 'worktree-1',
        project_id: data.project_id,
        name: data.name,
        branch_name: data.branch_name,
        path: data.path,
        status: 'active',
        is_default: data.is_default,
        branch_renamed: 0,
        last_message_at: null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        attachments: '[]',
        pinned: 0,
        context: null,
        github_pr_number: null,
        github_pr_url: null,
        base_branch: null,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      })
    )
    const db = { createProject, createWorktree }

    const result = createProjectWithDefaultWorktree(db as never, {
      name: 'repo',
      path: '/repo'
    })

    expect(result).toBe(project)
    expect(createProject).toHaveBeenCalledWith({ name: 'repo', path: '/repo' })
    expect(createWorktree).toHaveBeenCalledWith({
      project_id: 'project-1',
      name: '(no-worktree)',
      branch_name: '',
      path: '/repo',
      is_default: true
    })
  })
})
