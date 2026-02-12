import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { SessionTabs } from '../../../src/renderer/src/components/sessions/SessionTabs'

/**
 * Session 8: Tab Context Menus — UI
 *
 * Tests verify:
 * 1. Session tab context menu has Close, Close Others, Close Others to the Right
 * 2. File tab context menu has close actions + Copy Relative Path, Copy Absolute Path
 * 3. Diff tab context menu has same items as file tabs
 * 4. Context menu actions call the correct store methods
 * 5. Copy path actions write to clipboard
 */

// Mock window.db for session store
Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: {
    session: {
      getActiveByWorktree: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'new', name: 'New', status: 'active' }),
      update: vi.fn().mockResolvedValue({ id: 'test', status: 'completed' })
    },
    worktree: {
      updateModel: vi.fn().mockResolvedValue({ success: true })
    }
  }
})

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
  writable: true,
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined)
  }
})

// Mock the settings store's autoStartSession
vi.mock('../../../src/renderer/src/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        autoStartSession: false,
        selectedModel: null
      }),
    {
      getState: () => ({
        autoStartSession: false,
        selectedModel: null
      })
    }
  )
}))

const worktreeId = 'wt-test'
const projectId = 'proj-test'

function setupStores({
  sessionCount = 3,
  fileTabs = false,
  diffTabs = false
}: {
  sessionCount?: number
  fileTabs?: boolean
  diffTabs?: boolean
} = {}) {
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    id: `s${i + 1}`,
    worktree_id: worktreeId,
    project_id: projectId,
    name: `Session ${i + 1}`,
    status: 'active' as const,
    opencode_session_id: null,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: `2024-01-0${i + 1}`,
    updated_at: `2024-01-0${i + 1}`,
    completed_at: null
  }))

  useSessionStore.setState({
    sessionsByWorktree: new Map([[worktreeId, sessions]]),
    tabOrderByWorktree: new Map([[worktreeId, sessions.map((s) => s.id)]]),
    activeSessionId: 's1',
    activeWorktreeId: worktreeId,
    activeSessionByWorktree: { [worktreeId]: 's1' },
    modeBySession: new Map(sessions.map((s) => [s.id, 'build'])),
    pendingMessages: new Map(),
    isLoading: false,
    error: null
  })

  useWorktreeStore.setState({
    selectedWorktreeId: worktreeId,
    worktreesByProject: new Map([
      [
        projectId,
        [
          {
            id: worktreeId,
            project_id: projectId,
            name: 'worktree',
            branch_name: 'main',
            path: '/test/project/worktree',
            status: 'active' as const,
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            created_at: '2024-01-01',
            last_accessed_at: '2024-01-01'
          }
        ]
      ]
    ])
  })

  useProjectStore.setState({
    projects: [
      {
        id: projectId,
        name: 'Test Project',
        path: '/test/project',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2024-01-01',
        last_accessed_at: '2024-01-01'
      }
    ]
  })

  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    lastMessageTimeByWorktree: {}
  })

  // Set up file/diff tabs if requested
  const openFiles = new Map()

  if (fileTabs) {
    openFiles.set('/test/project/worktree/src/app.ts', {
      type: 'file' as const,
      path: '/test/project/worktree/src/app.ts',
      name: 'app.ts',
      worktreeId
    })
    openFiles.set('/test/project/worktree/src/utils.ts', {
      type: 'file' as const,
      path: '/test/project/worktree/src/utils.ts',
      name: 'utils.ts',
      worktreeId
    })
  }

  if (diffTabs) {
    openFiles.set('diff:src/changed.ts:unstaged', {
      type: 'diff' as const,
      worktreePath: '/test/project/worktree',
      filePath: 'src/changed.ts',
      fileName: 'changed.ts',
      staged: false,
      isUntracked: false
    })
  }

  useFileViewerStore.setState({
    openFiles,
    activeFilePath: null,
    activeDiff: null
  })
}

describe('Session 8: Tab Context Menus UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStores()
  })

  describe('Session tab context menu', () => {
    test('right-click shows Close, Close Others, Close Others to the Right', async () => {
      render(<SessionTabs />)

      const tab = screen.getByTestId('session-tab-s1')
      fireEvent.contextMenu(tab)

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument()
        expect(screen.getByText('Close Others')).toBeInTheDocument()
        expect(screen.getByText('Close Others to the Right')).toBeInTheDocument()
      })
    })

    test('session tab context menu does NOT have copy path items', async () => {
      render(<SessionTabs />)

      const tab = screen.getByTestId('session-tab-s1')
      fireEvent.contextMenu(tab)

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument()
      })

      expect(screen.queryByText('Copy Relative Path')).not.toBeInTheDocument()
      expect(screen.queryByText('Copy Absolute Path')).not.toBeInTheDocument()
    })
  })

  describe('File tab context menu', () => {
    test('right-click shows close actions and copy path items', async () => {
      setupStores({ fileTabs: true })
      render(<SessionTabs />)

      const fileTab = screen.getByTestId('file-tab-app.ts')
      fireEvent.contextMenu(fileTab)

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument()
        expect(screen.getByText('Close Others')).toBeInTheDocument()
        expect(screen.getByText('Close Others to the Right')).toBeInTheDocument()
        expect(screen.getByText('Copy Relative Path')).toBeInTheDocument()
        expect(screen.getByText('Copy Absolute Path')).toBeInTheDocument()
      })
    })

    test('Copy Relative Path copies to clipboard', async () => {
      setupStores({ fileTabs: true })
      render(<SessionTabs />)

      const fileTab = screen.getByTestId('file-tab-app.ts')
      fireEvent.contextMenu(fileTab)

      await waitFor(() => {
        expect(screen.getByText('Copy Relative Path')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Copy Relative Path'))

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('src/app.ts')
      })
    })

    test('Copy Absolute Path copies to clipboard', async () => {
      setupStores({ fileTabs: true })
      render(<SessionTabs />)

      const fileTab = screen.getByTestId('file-tab-app.ts')
      fireEvent.contextMenu(fileTab)

      await waitFor(() => {
        expect(screen.getByText('Copy Absolute Path')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Copy Absolute Path'))

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          '/test/project/worktree/src/app.ts'
        )
      })
    })
  })

  describe('Diff tab context menu', () => {
    test('right-click shows close actions and copy path items', async () => {
      setupStores({ diffTabs: true })
      render(<SessionTabs />)

      const diffTab = screen.getByTestId('diff-tab-changed.ts')
      fireEvent.contextMenu(diffTab)

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument()
        expect(screen.getByText('Close Others')).toBeInTheDocument()
        expect(screen.getByText('Close Others to the Right')).toBeInTheDocument()
        expect(screen.getByText('Copy Relative Path')).toBeInTheDocument()
        expect(screen.getByText('Copy Absolute Path')).toBeInTheDocument()
      })
    })

    test('Copy Relative Path copies diff filePath', async () => {
      setupStores({ diffTabs: true })
      render(<SessionTabs />)

      const diffTab = screen.getByTestId('diff-tab-changed.ts')
      fireEvent.contextMenu(diffTab)

      await waitFor(() => {
        expect(screen.getByText('Copy Relative Path')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Copy Relative Path'))

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('src/changed.ts')
      })
    })

    test('Copy Absolute Path copies worktreePath/filePath', async () => {
      setupStores({ diffTabs: true })
      render(<SessionTabs />)

      const diffTab = screen.getByTestId('diff-tab-changed.ts')
      fireEvent.contextMenu(diffTab)

      await waitFor(() => {
        expect(screen.getByText('Copy Absolute Path')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Copy Absolute Path'))

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          '/test/project/worktree/src/changed.ts'
        )
      })
    })
  })

  describe('Keyboard shortcut hints', () => {
    test('Close menu item shows Cmd+W shortcut', async () => {
      render(<SessionTabs />)

      const tab = screen.getByTestId('session-tab-s1')
      fireEvent.contextMenu(tab)

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument()
        // The shortcut symbol should be present
        expect(screen.getByText('\u2318W')).toBeInTheDocument()
      })
    })
  })
})
