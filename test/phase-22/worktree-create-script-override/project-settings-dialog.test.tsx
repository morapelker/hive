import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProjectSettingsDialog } from '../../../src/renderer/src/components/projects/ProjectSettingsDialog'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const mockProjectOps = {
  detectSetupSuggestions: vi.fn().mockResolvedValue({ success: true, value: [] }),
  pickProjectIcon: vi.fn(),
  removeProjectIcon: vi.fn(),
  loadLanguageIcons: vi.fn().mockResolvedValue({ success: true, value: [] })
}

Object.defineProperty(window, 'projectOps', {
  writable: true,
  configurable: true,
  value: mockProjectOps
})

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
    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null
    })
  })

  test('renders the Worktree Create Script textarea', () => {
    render(
      <ProjectSettingsDialog
        project={makeProject()}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const label = screen.getByText('Worktree Create Script')
    expect(label).toBeTruthy()
  })

  test('loads existing worktree_create_script value into the textarea', () => {
    const existingScript = 'git worktree add --no-checkout "$HIVE_WORKTREE_PATH"'
    render(
      <ProjectSettingsDialog
        project={makeProject({ worktree_create_script: existingScript })}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const textarea = screen.getByDisplayValue(existingScript)
    expect(textarea).toBeTruthy()
  })

  test('saves the entered script via updateProject', async () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    useProjectStore.setState({ updateProject } as Partial<ReturnType<typeof useProjectStore.getState>> as ReturnType<typeof useProjectStore.getState>)

    render(
      <ProjectSettingsDialog
        project={makeProject()}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const label = screen.getByText('Worktree Create Script')
    const wrapper = label.closest('div.space-y-1\\.5') as HTMLElement
    const textarea = wrapper.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()

    const user = userEvent.setup()
    await user.click(textarea)
    await user.type(textarea, 'custom-create-script')

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    expect(updateProject).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({
        worktree_create_script: 'custom-create-script'
      })
    )
  })

  test('saves null when the textarea is cleared', async () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    useProjectStore.setState({ updateProject } as Partial<ReturnType<typeof useProjectStore.getState>> as ReturnType<typeof useProjectStore.getState>)

    render(
      <ProjectSettingsDialog
        project={makeProject({ worktree_create_script: 'old-script' })}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const textarea = screen.getByDisplayValue('old-script') as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.clear(textarea)

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    expect(updateProject).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({
        worktree_create_script: null
      })
    )
  })
})
