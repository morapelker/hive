import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import type { BackupFile, ProjectClassification } from '@shared/types/backup'
import { RestoreWizard } from './RestoreWizard'

function makeProject(name: string, path: string, remoteUrl: string | null): BackupFile['projects'][number] {
  return {
    name,
    path,
    remote_url: remoteUrl,
    description: null,
    tags: null,
    language: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    sort_order: 0,
    kanban_simple_mode: false,
    kanban_storage_mode: 'internal',
    kanban_markdown_config: null,
    custom_icon: null,
    worktrees: [],
    tickets: null,
    ticket_dependencies: null
  }
}

const backup: BackupFile = {
  version: 1,
  kind: 'hive-backup',
  created_at: '2026-07-09T00:00:00.000Z',
  app_version: '1.2.12',
  projects: [
    makeProject('exists-proj', '/Users/me/exists-proj', 'git@github.com:a/exists.git'),
    makeProject('clone-proj', '/Users/me/clone-proj', 'git@github.com:a/clone.git'),
    makeProject('conflict-proj', '/Users/me/conflict-proj', 'git@github.com:a/conflict.git'),
    makeProject('no-remote-proj', '/Users/me/no-remote-proj', null)
  ]
}

const classifications: ProjectClassification[] = [
  {
    path: '/Users/me/exists-proj',
    classification: 'exists-match',
    alreadyInHive: true,
    hiveProjectId: 'project-1',
    effectivePath: '/Users/me/exists-proj',
    localRemoteUrl: 'git@github.com:a/exists.git'
  },
  {
    path: '/Users/me/clone-proj',
    classification: 'missing-clone',
    alreadyInHive: false,
    hiveProjectId: null,
    effectivePath: '/Users/me/clone-proj',
    localRemoteUrl: null
  },
  {
    path: '/Users/me/conflict-proj',
    classification: 'conflict',
    alreadyInHive: false,
    hiveProjectId: null,
    effectivePath: '/Users/me/conflict-proj',
    localRemoteUrl: 'git@github.com:other/repo.git'
  },
  {
    path: '/Users/me/no-remote-proj',
    classification: 'skipped-no-remote',
    alreadyInHive: false,
    hiveProjectId: null,
    effectivePath: '/Users/me/no-remote-proj',
    localRemoteUrl: null
  }
]

function setup(): ReturnType<typeof vi.fn> {
  const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
    if (method === 'backupOps.classifyProjects') return classifications
    throw new Error(`unexpected method ${method}`)
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })
  return request
}

describe('RestoreWizard', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  it('classifies projects on open and renders badges per classification', async () => {
    setup()
    render(<RestoreWizard backup={backup} open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('Exists — will pull')
    expect(screen.getByText('Already in Hive')).not.toBeNull()
    expect(screen.getByText('Will clone')).not.toBeNull()
    expect(screen.getByText('Conflict — different repo here')).not.toBeNull()
    expect(screen.getByText("No remote — can't restore")).not.toBeNull()
  })

  it('defaults to all enabled rows selected and disables conflict/no-remote rows', async () => {
    setup()
    render(<RestoreWizard backup={backup} open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('Exists — will pull')

    // 2 enabled rows (exists-match, missing-clone) selected by default.
    expect(screen.getByText('2 selected')).not.toBeNull()

    const conflictRow = screen.getByText('conflict-proj').closest('label')
    const noRemoteRow = screen.getByText('no-remote-proj').closest('label')
    expect(conflictRow).not.toBeNull()
    expect(noRemoteRow).not.toBeNull()

    const conflictCheckbox = within(conflictRow!).getByRole('checkbox')
    const noRemoteCheckbox = within(noRemoteRow!).getByRole('checkbox')
    expect(conflictCheckbox).toHaveAttribute('disabled')
    expect(noRemoteCheckbox).toHaveAttribute('disabled')
    expect(conflictCheckbox).toHaveAttribute('aria-checked', 'false')
    expect(noRemoteCheckbox).toHaveAttribute('aria-checked', 'false')
  })

  it('select-all only toggles enabled rows, and clicking a disabled row is a no-op', async () => {
    const user = userEvent.setup()
    setup()
    render(<RestoreWizard backup={backup} open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('Exists — will pull')
    expect(screen.getByText('2 selected')).not.toBeNull()

    const conflictRow = screen.getByText('conflict-proj').closest('label')!
    const conflictCheckbox = within(conflictRow).getByRole('checkbox')
    await user.click(conflictCheckbox)
    // Still 2 selected — disabled row cannot be toggled.
    expect(screen.getByText('2 selected')).not.toBeNull()

    const selectAll = screen.getByText('Select all').closest('div')!
    const selectAllCheckbox = within(selectAll).getByRole('checkbox')
    await user.click(selectAllCheckbox)
    expect(screen.getByText('0 selected')).not.toBeNull()

    await user.click(selectAllCheckbox)
    expect(screen.getByText('2 selected')).not.toBeNull()
  })

  it('Continue is disabled with zero selection and moves to the folder step when a clone is selected', async () => {
    const user = userEvent.setup()
    setup()
    render(<RestoreWizard backup={backup} open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('Exists — will pull')

    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).not.toBeDisabled()

    await user.click(continueButton)
    await act(async () => {})

    expect(screen.getByText('Browse…')).not.toBeNull()
    expect(screen.getByText(/will be cloned into the folder you choose/)).not.toBeNull()
  })
})
