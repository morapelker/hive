import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { useSettingsStore } from '@/stores/useSettingsStore'

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  loadProjects: vi.fn()
}))

vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: () => ({
    updateProject: mocks.updateProject,
    loadProjects: mocks.loadProjects
  })
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const mockProjectOps = vi.hoisted(() => ({
  detectSetupSuggestions: vi.fn().mockResolvedValue([]),
  pickProjectIcon: vi.fn(),
  removeProjectIcon: vi.fn(),
  loadLanguageIcons: vi.fn().mockResolvedValue([])
}))

vi.mock('@/api/project-api', () => ({
  projectApi: mockProjectOps
}))

const DEFAULT_SCRIPT = 'pnpm install\npnpm run build'

function makeProject(setupScript: string | null) {
  return {
    id: 'test-project-id',
    name: 'Test Project',
    path: '/tmp/test-project',
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: setupScript,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false
  }
}

async function openDialog(setupScript: string | null): Promise<{
  user: ReturnType<typeof userEvent.setup>
  textarea: HTMLTextAreaElement
}> {
  render(
    <ProjectSettingsDialog project={makeProject(setupScript)} open={true} onOpenChange={vi.fn()} />
  )
  await waitFor(() => expect(mockProjectOps.detectSetupSuggestions).toHaveBeenCalled())
  return {
    user: userEvent.setup(),
    textarea: screen.getByTestId('project-setup-script-input') as HTMLTextAreaElement
  }
}

async function save(user: ReturnType<typeof userEvent.setup>): Promise<unknown> {
  await user.click(screen.getByRole('button', { name: /^save$/i }))
  await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled())
  return mocks.updateProject.mock.calls[0][1].setup_script
}

describe('ProjectSettingsDialog — default setup script', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateProject.mockResolvedValue(true)
    mocks.loadProjects.mockResolvedValue(undefined)
    useSettingsStore.setState({ defaultSetupScript: DEFAULT_SCRIPT })
  })

  test('a project with no script of its own shows the default and keeps following it on save', async () => {
    const { user, textarea } = await openDialog(null)

    expect(textarea.value).toBe(DEFAULT_SCRIPT)
    expect(screen.getByTestId('project-setup-script-default-status').textContent).toContain(
      'Using the default setup script'
    )
    expect(screen.queryByTestId('project-setup-script-reset')).toBeNull()

    expect(await save(user)).toBeNull()
  })

  test('clearing the default is saved as an empty script, not as "not set"', async () => {
    const { user, textarea } = await openDialog(null)

    await user.clear(textarea)
    expect(screen.getByTestId('project-setup-script-default-status').textContent).toContain(
      'No setup script runs for this project'
    )

    expect(await save(user)).toBe('')
  })

  test('a cleared script stays cleared when the dialog is reopened and saved', async () => {
    const { user, textarea } = await openDialog('')

    expect(textarea.value).toBe('')
    expect(screen.getByTestId('project-setup-script-default-status').textContent).toContain(
      'No setup script runs for this project'
    )

    expect(await save(user)).toBe('')
  })

  test('editing the default saves the edit as the project script', async () => {
    const { user, textarea } = await openDialog(null)

    await user.clear(textarea)
    await user.type(textarea, 'bun install')
    expect(screen.getByTestId('project-setup-script-default-status').textContent).toContain(
      'Overrides the default setup script'
    )

    expect(await save(user)).toBe('bun install')
  })

  test('"Use default" puts an overriding project back on the default', async () => {
    const { user, textarea } = await openDialog('bun install')

    expect(textarea.value).toBe('bun install')
    await user.click(screen.getByTestId('project-setup-script-reset'))
    expect(textarea.value).toBe(DEFAULT_SCRIPT)

    expect(await save(user)).toBeNull()
  })

  test('without a default, an emptied field stays "not set" and no default status shows', async () => {
    useSettingsStore.setState({ defaultSetupScript: '' })
    const { user, textarea } = await openDialog(null)

    expect(textarea.value).toBe('')
    expect(screen.queryByTestId('project-setup-script-default-status')).toBeNull()
    await user.type(textarea, 'x')
    await user.clear(textarea)

    expect(await save(user)).toBeNull()
  })
})
