import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ModelIcon } from './ModelIcon'
import { useSettingsStore, useSessionStore, useWorktreeStore } from '@/stores'

const baseWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'Feature',
  branch_name: 'feature',
  path: '/tmp/feature',
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
}

describe('ModelIcon', () => {
  beforeEach(() => {
    useSettingsStore.setState({ showModelIcons: true })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map()
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map()
    })
  })

  it('renders Claude for the Claude Agent SDK provider recorded on the worktree', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              ...baseWorktree,
              last_model_provider_id: 'claude-code',
              last_model_id: 'opus'
            }
          ]
        ]
      ])
    })

    render(<ModelIcon worktreeId="worktree-1" />)

    expect(screen.getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  })
})
