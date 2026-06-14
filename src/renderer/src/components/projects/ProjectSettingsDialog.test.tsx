import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { useKanbanStore } from '@/stores/useKanbanStore'

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  loadProjects: vi.fn()
}))

const projectApiMocks = vi.hoisted(() => ({
  detectSetupSuggestions: vi.fn().mockResolvedValue([]),
  loadLanguageIcons: vi.fn().mockResolvedValue({}),
  getProjectIconPath: vi.fn().mockResolvedValue(null),
  getAbsoluteIconDataUrl: vi.fn().mockResolvedValue(null),
  pickProjectIcon: vi.fn(),
  removeProjectIcon: vi.fn()
}))

const kanbanApiMocks = vi.hoisted(() => ({
  config: {
    get: vi.fn(),
    update: vi.fn(),
    setMode: vi.fn(),
    createFolders: vi.fn(),
    pickMarkdownFolder: vi.fn()
  }
}))

vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: () => ({
    updateProject: mocks.updateProject,
    loadProjects: mocks.loadProjects
  })
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: kanbanApiMocks
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

function renderDialog(projectOverrides: Partial<Project> = {}, onOpenChange = vi.fn()) {
  return render(
    <ProjectSettingsDialog
      project={{ ...baseProject, ...projectOverrides }}
      open={true}
      onOpenChange={onOpenChange}
    />
  )
}

describe('ProjectSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateProject.mockResolvedValue(true)
    mocks.loadProjects.mockResolvedValue(undefined)
    projectApiMocks.detectSetupSuggestions.mockResolvedValue([])
    projectApiMocks.loadLanguageIcons.mockResolvedValue({})
    projectApiMocks.getProjectIconPath.mockResolvedValue(null)
    projectApiMocks.getAbsoluteIconDataUrl.mockResolvedValue(null)
    kanbanApiMocks.config.get.mockResolvedValue({
      mode: 'internal',
      markdown: {
        layout: 'single-folder',
        singleFolder: 'docs/kanban',
        statusFolders: {
          todo: 'docs/kanban/todo',
          in_progress: 'docs/kanban/in-progress',
          review: 'docs/kanban/review',
          done: 'docs/kanban/done'
        }
      }
    })
    kanbanApiMocks.config.update.mockResolvedValue({
      mode: 'markdown',
      markdown: {
        layout: 'single-folder',
        singleFolder: 'docs/kanban',
        statusFolders: {
          todo: 'docs/kanban/todo',
          in_progress: 'docs/kanban/in-progress',
          review: 'docs/kanban/review',
          done: 'docs/kanban/done'
        }
      }
    })
    kanbanApiMocks.config.setMode.mockResolvedValue({ success: true })
    kanbanApiMocks.config.createFolders.mockResolvedValue({ success: true })
    useKanbanStore.setState({ loadTickets: vi.fn() })
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

  it('saves project fields before showing a Kanban mode-change failure', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    kanbanApiMocks.config.setMode.mockResolvedValue({
      success: false,
      error: 'Changing Kanban storage mode is only supported for projects with no cards.'
    })

    renderDialog({}, onOpenChange)

    await waitFor(() => expect(projectApiMocks.detectSetupSuggestions).toHaveBeenCalled())
    await user.type(screen.getByPlaceholderText(/npm install/), 'pnpm install')
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({
          setup_script: 'pnpm install'
        })
      )
    })
    expect(kanbanApiMocks.config.update).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ layout: 'single-folder' })
    )
    expect(kanbanApiMocks.config.setMode).toHaveBeenCalledWith('project-1', 'markdown')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(
      await screen.findByText(
        'Changing Kanban storage mode is only supported for projects with no cards.'
      )
    ).toBeTruthy()
  })
})
