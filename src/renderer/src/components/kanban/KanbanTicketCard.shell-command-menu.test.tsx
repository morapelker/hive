/**
 * The ticket context menu lists the project's shell commands. A ticket on a non-base
 * worktree gets two labelled sections (its worktree, then the base branch); any other
 * ticket gets one unlabelled list that launches on the base worktree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ProjectShellCommand } from '@shared/lib/shell-commands'
import type { KanbanTicket } from '../../../../main/db/types'

const mocks = vi.hoisted(() => ({
  runProjectShellCommand: vi.fn()
}))

vi.mock('@/lib/shell-command-launch', () => ({
  runProjectShellCommand: mocks.runProjectShellCommand
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const now = '2026-01-01T00:00:00.000Z'

const makeCommands = (count: number): ProjectShellCommand[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `cmd-${index + 1}`,
    name: `Command ${index + 1}`,
    commands: `echo ${index + 1}`
  }))

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
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
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

const worktree = (id: string, name: string, isDefault: boolean) => ({
  id,
  project_id: 'project-1',
  name,
  branch_name: name,
  path: `/tmp/${id}`,
  status: 'active',
  is_default: isDefault,
  created_at: now,
  last_accessed_at: now
})

function seed(commands: ProjectShellCommand[], kind?: 'connection'): void {
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'project-1',
        path: '/tmp/project-1',
        ...(kind ? { kind } : {}),
        shell_commands: commands
      }
    ]
  } as never)
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      ['project-1', [worktree('wt-base', 'main', true), worktree('wt-feature', 'feature-x', false)]]
    ])
  } as never)
}

const openMenu = (): void => {
  fireEvent.contextMenu(screen.getByTestId('kanban-ticket-ticket-1'))
}

const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

/** Menu labels and command items, in document order. */
const sectionRows = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] > *'))
    .map((row) => row.textContent ?? '')
    .filter((text) => /^(Command \d+|Run Command|main|feature-x)$/.test(text))

// See ProjectItem.shell-commands.test.tsx: jsdom cannot answer floating-ui's top-layer probes
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

describe('KanbanTicketCard shell commands in the context menu', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.runProjectShellCommand.mockResolvedValue({ success: true })
  })

  it('lists the commands once, unlabelled, for a ticket without a worktree', () => {
    seed(makeCommands(2))
    render(<KanbanTicketCard ticket={makeTicket()} />)

    openMenu()
    expect(sectionRows()).toEqual(['Command 1', 'Command 2'])

    fireEvent.click(menuItems().find((item) => item.textContent === 'Command 2')!)
    expect(mocks.runProjectShellCommand).toHaveBeenCalledTimes(1)
    const input = mocks.runProjectShellCommand.mock.calls[0][0]
    expect(input).toMatchObject({ projectId: 'project-1', commandId: 'cmd-2' })
    expect(input.worktreeId ?? null).toBeNull()
  })

  it('lists the commands once for a ticket on the base worktree', () => {
    seed(makeCommands(2))
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'wt-base' })} />)

    openMenu()
    expect(sectionRows()).toEqual(['Command 1', 'Command 2'])
  })

  it('shows a worktree section and a base branch section for a worktree ticket', () => {
    seed(makeCommands(2))
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'wt-feature' })} />)

    openMenu()
    expect(sectionRows()).toEqual([
      'feature-x',
      'Command 1',
      'Command 2',
      'main',
      'Command 1',
      'Command 2'
    ])

    const first = menuItems().filter((item) => item.textContent === 'Command 1')
    expect(first).toHaveLength(2)

    fireEvent.click(first[0])
    expect(mocks.runProjectShellCommand.mock.calls[0][0]).toMatchObject({
      projectId: 'project-1',
      commandId: 'cmd-1',
      worktreeId: 'wt-feature'
    })
  })

  it('runs on the base worktree from the base branch section', () => {
    seed(makeCommands(2))
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'wt-feature' })} />)

    openMenu()
    fireEvent.click(menuItems().filter((item) => item.textContent === 'Command 1')[1])

    const input = mocks.runProjectShellCommand.mock.calls[0][0]
    expect(input).toMatchObject({ projectId: 'project-1', commandId: 'cmd-1' })
    expect(input.worktreeId ?? null).toBeNull()
  })

  it('shows no commands for a connection project', () => {
    seed(makeCommands(2), 'connection')
    render(<KanbanTicketCard ticket={makeTicket()} />)

    openMenu()
    expect(menuItems().length).toBeGreaterThan(0)
    expect(sectionRows()).toEqual([])
  })
})
