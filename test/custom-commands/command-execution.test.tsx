// test/custom-commands/command-execution.test.tsx

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorktreeItem } from '../../src/renderer/src/components/worktrees/WorktreeItem'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useSpaceStore } from '../../src/renderer/src/stores/useSpaceStore'
import { useConnectionStore } from '../../src/renderer/src/stores/useConnectionStore'
import { useHintStore } from '../../src/renderer/src/stores/useHintStore'
import { useVimModeStore } from '../../src/renderer/src/stores/useVimModeStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

// Mock window APIs
if (!window.projectOps) {
  Object.defineProperty(window, 'projectOps', {
    writable: true,
    configurable: true,
    value: {
      showInFolder: vi.fn().mockResolvedValue(undefined),
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
      loadLanguageIcons: vi.fn().mockResolvedValue([])
    }
  })
}

if (!window.worktreeOps) {
  Object.defineProperty(window, 'worktreeOps', {
    writable: true,
    configurable: true,
    value: {
      hasCommits: vi.fn().mockResolvedValue(true),
      createFromBranch: vi.fn().mockResolvedValue({ success: true })
    }
  })
}

describe('Custom Command Execution', () => {
  const mockProject = {
    id: 'proj-1',
    name: 'Test Project',
    path: '/path/to/project',
    description: 'Test description',
    tags: 'test,tags',
    language: 'typescript',
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    last_accessed_at: '2024-01-01T00:00:00Z'
  }

  const mockWorktree = {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'main',
    branch_name: 'main',
    path: '/path/to/project',
    status: 'active' as const,
    is_default: true,
    last_message_at: null,
    created_at: '2024-01-01T00:00:00Z',
    last_accessed_at: '2024-01-01T00:00:00Z',
    attachments: '[]'
  }

  beforeEach(() => {
    // Reset all stores
    useProjectStore.setState({
      selectedProjectId: null,
      projects: [mockProject],
      expandedProjectIds: new Set(),
      editingProjectId: null,
      selectProject: vi.fn(),
      toggleProjectExpanded: vi.fn(),
      setEditingProject: vi.fn(),
      updateProjectName: vi.fn(),
      removeProject: vi.fn(),
      refreshLanguage: vi.fn(),
      openProjectSettings: vi.fn()
    } as any)

    useWorktreeStore.setState({
      createWorktree: vi.fn(),
      creatingForProjectId: null,
      syncWorktrees: vi.fn()
    } as any)

    useSpaceStore.setState({
      spaces: [],
      projectSpaceMap: {},
      assignProjectToSpace: vi.fn(),
      removeProjectFromSpace: vi.fn()
    } as any)

    useConnectionStore.setState({
      connectionModeActive: false
    } as any)

    useHintStore.setState({
      hintMap: new Map(),
      mode: 'default',
      pendingChar: null,
      actionMode: null,
      filterActive: false,
      inputFocused: false
    } as any)

    useVimModeStore.setState({
      mode: 'insert'
    } as any)

    useSettingsStore.setState({
      vimModeEnabled: false,
      autoPullBeforeWorktree: false,
      customProjectCommands: [
        {
          id: 'cmd-1',
          name: 'Test Command',
          prompt: 'Test {{project.name}} in {{project.path}}'
        }
      ]
    } as any)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should dispatch hive:execute-custom-command event when custom command is clicked', async () => {
    const user = userEvent.setup()

    // Create event spy
    const eventSpy = vi.fn()
    window.addEventListener('hive:execute-custom-command', eventSpy)

    render(<WorktreeItem worktree={mockWorktree} projectPath={mockProject.path} />)

    // Find and right-click the project item
    const worktreeItem = screen.getByTestId('worktree-item-wt-1')
    await user.pointer({ keys: '[MouseRight]', target: worktreeItem })

    // Find and click the custom command in context menu
    const customCommand = await screen.findByText('Test Command')
    await user.click(customCommand)

    // Verify event was dispatched with correct detail
    expect(eventSpy).toHaveBeenCalledTimes(1)
    const event = eventSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('hive:execute-custom-command')
    expect(event.detail).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      commandId: 'cmd-1',
      commandName: 'Test Command',
      renderedPrompt: 'Test Test Project in /path/to/project'
    })

    window.removeEventListener('hive:execute-custom-command', eventSpy)
  })

  it('should replace template variables in prompt before dispatching', async () => {
    const user = userEvent.setup()
    const eventSpy = vi.fn()
    window.addEventListener('hive:execute-custom-command', eventSpy)

    render(<WorktreeItem worktree={mockWorktree} projectPath={mockProject.path} />)

    const worktreeItem = screen.getByTestId('worktree-item-wt-1')
    await user.pointer({ keys: '[MouseRight]', target: worktreeItem })

    const customCommand = await screen.findByText('Test Command')
    await user.click(customCommand)

    const event = eventSpy.mock.calls[0][0] as CustomEvent
    expect(event.detail.renderedPrompt).toBe('Test Test Project in /path/to/project')
    expect(event.detail.renderedPrompt).not.toContain('{{')

    window.removeEventListener('hive:execute-custom-command', eventSpy)
  })
})
