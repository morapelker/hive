// test/custom-commands/e2e-integration.test.tsx

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('Custom Commands E2E Integration', () => {
  const mockProject = {
    id: 'test-project-123',
    name: 'MyApp',
    path: '/Users/test/myapp',
    description: 'My application',
    tags: 'react,typescript',
    language: 'TypeScript',
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2024-01-01',
    last_accessed_at: '2024-01-02'
  }

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

    // Reset settings with empty custom commands
    useSettingsStore.setState({
      vimModeEnabled: false,
      autoPullBeforeWorktree: false,
      customProjectCommands: []
    } as any)
  })

  it('should execute custom command end-to-end with template replacement', async () => {
    const user = userEvent.setup()

    // Set up custom commands in settings
    const commands = [
      {
        id: 'cmd-analyze',
        name: 'Analyze Architecture',
        prompt: 'Analyze the architecture of {{project.name}} located at {{project.path}}. Language: {{project.language}}.'
      }
    ]

    useSettingsStore.setState({
      customProjectCommands: commands
    } as any)

    // Mock event listener
    const eventListener = vi.fn()
    window.addEventListener('hive:execute-custom-command', eventListener)

    // Render component
    render(<ProjectItem project={mockProject} />)

    // Open context menu
    const projectItem = screen.getByTestId('project-item-test-project-123')
    await user.pointer({ keys: '[MouseRight]', target: projectItem })

    // Click custom command
    const analyzeCommand = await screen.findByText('Analyze Architecture')
    await user.click(analyzeCommand)

    // Verify event was dispatched with correctly replaced variables
    await waitFor(() => {
      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            projectId: 'test-project-123',
            commandName: 'Analyze Architecture',
            renderedPrompt: 'Analyze the architecture of MyApp located at /Users/test/myapp. Language: TypeScript.'
          })
        })
      )
    })

    window.removeEventListener('hive:execute-custom-command', eventListener)
  })

  it('should handle multiple custom commands', async () => {
    const user = userEvent.setup()

    const commands = [
      {
        id: 'cmd-1',
        name: 'Command One',
        prompt: 'First command for {{project.name}}'
      },
      {
        id: 'cmd-2',
        name: 'Command Two',
        prompt: 'Second command for {{project.name}}'
      },
      {
        id: 'cmd-3',
        name: 'Command Three',
        prompt: 'Third command for {{project.name}}'
      }
    ]

    useSettingsStore.setState({
      customProjectCommands: commands
    } as any)

    render(<ProjectItem project={mockProject} />)

    // Open context menu
    const projectItem = screen.getByTestId('project-item-test-project-123')
    await user.pointer({ keys: '[MouseRight]', target: projectItem })

    // All three commands should be visible
    expect(await screen.findByText('Command One')).toBeInTheDocument()
    expect(screen.getByText('Command Two')).toBeInTheDocument()
    expect(screen.getByText('Command Three')).toBeInTheDocument()
  })
})
