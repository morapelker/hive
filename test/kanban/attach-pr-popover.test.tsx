import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AttachPRPopover } from '../../src/renderer/src/components/kanban/AttachPRPopover'
import { setRendererRpcClient, resetRendererRpcClientForTests } from '@/api/rpc-client'
import { gitApi } from '@/api/git-api'
import { toast } from '@/lib/toast'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../src/main/db/types'

vi.mock('@/components/ui/popover', () => ({
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/api/git-api', () => ({
  gitApi: {
    listPRs: vi.fn(),
    getPRState: vi.fn()
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn().mockResolvedValue([]),
    detectTerminals: vi.fn().mockResolvedValue([]),
    openWithTerminal: vi.fn().mockResolvedValue({ success: true }),
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    onStatus: vi.fn(() => () => {}),
    onSettingsUpdated: vi.fn(() => () => {}),
    onJumpToWorktree: vi.fn(() => () => {})
  }
}))

const ticket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Attach a pull request',
  description: null,
  attachments: [],
  column: 'todo',
  sort_order: 0,
  current_session_id: null,
  worktree_id: 'worktree-1',
  mode: null,
  plan_ready: false,
  created_at: '2026-05-29T00:00:00.000Z',
  updated_at: '2026-05-29T00:00:00.000Z',
  archived_at: null,
  external_provider: null,
  external_id: null,
  external_url: null,
  github_pr_number: null,
  github_pr_url: null,
  mark: null,
  total_tokens: 0,
  pending_launch_config: null
}

const ticketWithPr: KanbanTicket = {
  ...ticket,
  github_pr_number: 42,
  github_pr_url: 'https://github.com/acme/hive/pull/42'
}

describe('AttachPRPopover', () => {
  let request: ReturnType<typeof vi.fn>
  let attachPRToTicket: ReturnType<typeof vi.fn>
  let detachPRFromTicket: ReturnType<typeof vi.fn>
  let onOpenChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn((method: string) => {
      if (method === 'kanban.ticket.attachPR') return Promise.resolve(undefined)
      if (method === 'kanban.ticket.detachPR') return Promise.resolve(undefined)
      return Promise.resolve(undefined)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    attachPRToTicket = vi.fn()
    detachPRFromTicket = vi.fn()
    onOpenChange = vi.fn()

    vi.mocked(gitApi.listPRs).mockResolvedValue({
      success: true,
      prs: [
        {
          number: 42,
          title: 'Ship the branch',
          author: 'mor',
          headRefName: 'feature/attach-pr'
        }
      ]
    })

    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'Hive',
          path: '/repo/hive',
          description: null,
          tags: null,
          language: null,
          custom_icon: null,
          detected_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: '2026-05-29T00:00:00.000Z',
          last_accessed_at: '2026-05-29T00:00:00.000Z'
        }
      ]
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'Feature worktree',
              branch_name: 'feature/attach-pr',
              path: '/repo/hive/worktree',
              status: 'active',
              is_default: false,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              created_at: '2026-05-29T00:00:00.000Z',
              last_accessed_at: '2026-05-29T00:00:00.000Z',
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    useGitStore.setState({
      remoteInfo: new Map([
        [
          'worktree-1',
          {
            hasRemote: true,
            isGitHub: true,
            url: 'git@github.com:acme/hive.git'
          }
        ]
      ])
    })
    useKanbanStore.setState({ attachPRToTicket, detachPRFromTicket })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  test('attaches a pull request through kanbanApi', async () => {
    render(<AttachPRPopover ticket={ticket} open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('#42 — Ship the branch'))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('kanban.ticket.attachPR', {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        prNumber: 42,
        prUrl: 'https://github.com/acme/hive/pull/42'
      })
    })
    expect(attachPRToTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      42,
      'https://github.com/acme/hive/pull/42'
    )
    expect(detachPRFromTicket).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('PR #42 attached')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('detaches a pull request through kanbanApi', async () => {
    render(<AttachPRPopover ticket={ticketWithPr} open onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByTitle('Detach PR'))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('kanban.ticket.detachPR', {
        ticketId: 'ticket-1',
        projectId: 'project-1'
      })
    })
    expect(detachPRFromTicket).toHaveBeenCalledWith('ticket-1', 'project-1')
    expect(attachPRToTicket).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('PR detached')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
