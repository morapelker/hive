import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

const mockKanban = {
  ticket: {
    update: vi.fn().mockResolvedValue(undefined)
  }
}

const mockDbSession = {
  create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'session-1',
    worktree_id: input.worktree_id,
    project_id: input.project_id,
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: input.agent_sdk,
    mode: input.mode,
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null
  })),
  update: vi.fn().mockResolvedValue(undefined)
}

const mockOpencodeOps = {
  connect: vi.fn().mockResolvedValue({ success: true, sessionId: 'oc-session-1' }),
  prompt: vi.fn().mockResolvedValue({ success: true })
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: {
    session: mockDbSession
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  configurable: true,
  value: mockOpencodeOps
})

Object.defineProperty(window, 'usageOps', {
  writable: true,
  configurable: true,
  value: {
    fetch: vi.fn().mockResolvedValue({ success: true, data: null }),
    fetchOpenai: vi.fn().mockResolvedValue({ success: true, data: null })
  }
})

import { autoLaunchTicket } from '@/lib/auto-launch'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../src/main/db/types'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Implement auth flow',
    description: 'Add login and signup pages',
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    ...overrides
  }
}

describe('autoLaunchTicket goal mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useProjectStore.setState({
        projects: [
          {
            id: 'proj-1',
            name: 'Project',
            path: '/test/project',
            description: null,
            tags: null,
            language: null,
            setup_script: null,
            run_script: null,
            archive_script: null,
            custom_icon: null,
            auto_assign_port: false,
            sort_order: 0,
            created_at: '2026-01-01T00:00:00Z',
            last_accessed_at: '2026-01-01T00:00:00Z'
          }
        ]
      })
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              {
                id: 'wt-1',
                project_id: 'proj-1',
                name: 'feature-auth',
                branch_name: 'feature-auth',
                path: '/test/feature-auth',
                status: 'active',
                is_default: false,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                created_at: '2026-01-01T00:00:00Z',
                last_accessed_at: '2026-01-01T00:00:00Z',
                github_pr_number: null,
                github_pr_url: null
              }
            ]
          ]
        ])
      })
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [makeTicket()]]])
      })
      useSessionStore.setState({
        sessionsByWorktree: new Map(),
        modeBySession: new Map()
      })
      useSettingsStore.setState({
        availableAgentSdks: { opencode: true, claude: true, codex: true },
        defaultAgentSdk: 'codex',
        defaultModels: { build: null, plan: null, ask: null, review: null }
      })
    })
  })

  test('wraps queued Codex prompt in /goal and persists goal columns', async () => {
    const ticket = makeTicket({
      pending_launch_config: JSON.stringify({
        worktree: { type: 'existing', worktreeId: 'wt-1' },
        prompt: '/goal Build auth',
        mode: 'build',
        model: null,
        sdk: 'codex',
        codexFastMode: false,
        goalMode: true,
        goalSuccessCriteria: 'Auth works end to end'
      })
    })

    await autoLaunchTicket(ticket)

    expect(mockKanban.ticket.update).toHaveBeenCalledWith(
      'ticket-1',
      expect.objectContaining({
        pending_launch_config: null,
        current_session_id: 'session-1',
        worktree_id: 'wt-1',
        mode: 'build',
        goal_mode: true,
        goal_success_criteria: 'Auth works end to end'
      })
    )
    expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toBe('/goal Build auth. Goal success criteria: Auth works end to end')
  })
})
