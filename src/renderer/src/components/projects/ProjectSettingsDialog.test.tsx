import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn()
}))

const projectApiMocks = vi.hoisted(() => ({
  detectSetupSuggestions: vi.fn().mockResolvedValue([]),
  loadLanguageIcons: vi.fn().mockResolvedValue({}),
  getProjectIconPath: vi.fn().mockResolvedValue(null),
  getAbsoluteIconDataUrl: vi.fn().mockResolvedValue(null),
  pickProjectIcon: vi.fn(),
  removeProjectIcon: vi.fn()
}))

vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: () => ({
    updateProject: mocks.updateProject
  })
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

type Project = ComponentProps<typeof ProjectSettingsDialog>['project']

const baseProject: Project = {
  id: 'project-1',
  name: 'Hive',
  path: '/tmp/hive',
  language: 'typescript',
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false
}

function renderDialog(projectOverrides: Partial<Project> = {}) {
  return render(
    <ProjectSettingsDialog
      project={{ ...baseProject, ...projectOverrides }}
      open={true}
      onOpenChange={vi.fn()}
    />
  )
}

describe('ProjectSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateProject.mockResolvedValue(true)
    projectApiMocks.detectSetupSuggestions.mockResolvedValue([])
    projectApiMocks.loadLanguageIcons.mockResolvedValue({})
    projectApiMocks.getProjectIconPath.mockResolvedValue(null)
    projectApiMocks.getAbsoluteIconDataUrl.mockResolvedValue(null)
  })

  it('collapses the worktree create script section by default when no script is configured', async () => {
    renderDialog({ worktree_create_script: null })

    await waitFor(() => expect(projectApiMocks.detectSetupSuggestions).toHaveBeenCalled())

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'false')
    expect(screen.queryByText(/Advanced\. When set/)).toBeNull()
    expect(screen.queryByPlaceholderText(/git worktree add --no-checkout/)).toBeNull()
  })

  it('expands the worktree create script section by default when a script is configured', async () => {
    renderDialog({ worktree_create_script: 'echo custom-create' })

    await waitFor(() => expect(projectApiMocks.detectSetupSuggestions).toHaveBeenCalled())

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'true')
    expect(screen.getByDisplayValue('echo custom-create')).toBeTruthy()
  })

  it('lets users expand the worktree create script section when it starts collapsed', async () => {
    const user = userEvent.setup()
    renderDialog({ worktree_create_script: null })

    await waitFor(() => expect(projectApiMocks.detectSetupSuggestions).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: /worktree create script/i }))

    expect(
      screen.getByRole('button', { name: /worktree create script/i })
    ).toHaveProperty('ariaExpanded', 'true')
    expect(screen.getByPlaceholderText(/git worktree add --no-checkout/)).toBeTruthy()
  })
})
