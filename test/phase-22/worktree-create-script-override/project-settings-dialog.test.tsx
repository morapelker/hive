import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProjectSettingsDialog } from '../../../src/renderer/src/components/projects/ProjectSettingsDialog'

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn()
}))

vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: () => ({
    updateProject: mocks.updateProject
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

interface ProjectMock {
  id: string
  name: string
  path: string
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  worktree_create_script: string | null
  custom_commands: null
  auto_assign_port: boolean
  is_remote?: boolean
}

function makeProject(overrides: Partial<ProjectMock> = {}): ProjectMock {
  return {
    id: 'test-project-id',
    name: 'Test Project',
    path: '/tmp/test-project',
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    ...overrides
  }
}

describe('ProjectSettingsDialog — worktree_create_script field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateProject.mockResolvedValue(true)
  })

  test('renders the collapsed Worktree Create Script trigger', async () => {
    render(
      <ProjectSettingsDialog
        project={makeProject()}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    await waitFor(() => expect(mockProjectOps.detectSetupSuggestions).toHaveBeenCalled())

    const trigger = screen.getByRole('button', { name: /worktree create script/i })
    expect(trigger).toBeTruthy()
    expect(trigger).toHaveProperty('ariaExpanded', 'false')
  })

  test('loads existing worktree_create_script value into the textarea', async () => {
    const existingScript = 'git worktree add --no-checkout "$HIVE_WORKTREE_PATH"'
    render(
      <ProjectSettingsDialog
        project={makeProject({ worktree_create_script: existingScript })}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    await waitFor(() => expect(mockProjectOps.detectSetupSuggestions).toHaveBeenCalled())

    const textarea = screen.getByDisplayValue(existingScript)
    expect(textarea).toBeTruthy()
  })

  test('saves the entered script via updateProject', async () => {
    render(
      <ProjectSettingsDialog
        project={makeProject()}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const user = userEvent.setup()
    await waitFor(() => expect(mockProjectOps.detectSetupSuggestions).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: /worktree create script/i }))

    const textarea = screen.getByPlaceholderText(
      /git worktree add --no-checkout/
    ) as HTMLTextAreaElement
    expect(textarea).toBeTruthy()

    await user.click(textarea)
    await user.type(textarea, 'custom-create-script')

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    expect(mocks.updateProject).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({
        worktree_create_script: 'custom-create-script'
      })
    )
  })

  test('saves null when the textarea is cleared', async () => {
    render(
      <ProjectSettingsDialog
        project={makeProject({ worktree_create_script: 'old-script' })}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    await waitFor(() => expect(mockProjectOps.detectSetupSuggestions).toHaveBeenCalled())

    const textarea = screen.getByDisplayValue('old-script') as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.clear(textarea)

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    expect(mocks.updateProject).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({
        worktree_create_script: null
      })
    )
  })
})
