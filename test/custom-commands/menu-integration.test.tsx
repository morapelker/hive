// test/custom-commands/menu-integration.test.tsx

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { ProjectItem } from '../../src/renderer/src/components/projects/ProjectItem'
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

const mockProject = {
  id: 'test-project-id',
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
  created_at: '2026-01-01T00:00:00Z',
  last_accessed_at: '2026-01-01T00:00:00Z'
}

describe('ProjectItem - Custom Commands Menu Integration', () => {
  beforeEach(() => {
    // Reset all stores
    useProjectStore.setState({
      selectedProjectId: null,
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
      customProjectCommands: []
    } as any)
  })

  test('should not render custom commands section when no commands are configured', async () => {
    const user = userEvent.setup()

    render(<ProjectItem project={mockProject} />)

    const projectItem = screen.getByTestId('project-item-test-project-id')
    await user.pointer({ keys: '[MouseRight]', target: projectItem })

    // Context menu should open
    const menu = await screen.findByRole('menu')
    expect(menu).toBeInTheDocument()

    // Custom commands should not be present
    const menuItems = screen.queryAllByRole('menuitem')
    const customCommandItem = menuItems.find((item) => item.textContent?.includes('Test Command'))
    expect(customCommandItem).toBeUndefined()
  })

  test('should render custom commands in context menu when configured', async () => {
    const user = userEvent.setup()

    // Create event spy to verify command execution
    const eventSpy = vi.fn()
    window.addEventListener('hive:execute-custom-command', eventSpy)

    // Configure custom commands
    useSettingsStore.setState({
      customProjectCommands: [
        {
          id: 'cmd-1',
          name: 'Run Tests',
          prompt: 'Run tests for {{project.name}}'
        },
        {
          id: 'cmd-2',
          name: 'Generate Docs',
          prompt: 'Generate documentation for {{project.path}}'
        }
      ]
    } as any)

    render(<ProjectItem project={mockProject} />)

    const projectItem = screen.getByTestId('project-item-test-project-id')
    await user.pointer({ keys: '[MouseRight]', target: projectItem })

    // Context menu should open
    const menu = await screen.findByRole('menu')
    expect(menu).toBeInTheDocument()

    // Custom commands should be present
    expect(screen.getByText('Run Tests')).toBeInTheDocument()
    expect(screen.getByText('Generate Docs')).toBeInTheDocument()

    // Click the custom command
    await user.click(screen.getByText('Run Tests'))

    // Verify event was dispatched
    expect(eventSpy).toHaveBeenCalledTimes(1)
    const event = eventSpy.mock.calls[0][0] as CustomEvent
    expect(event.detail.commandName).toBe('Run Tests')

    window.removeEventListener('hive:execute-custom-command', eventSpy)
  })
})
