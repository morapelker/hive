import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { SessionTabs } from '../../../src/renderer/src/components/sessions/SessionTabs'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

const project = {
  id: 'project-1',
  name: 'Project One',
  path: '/repo/project-1',
  description: null,
  tags: null,
  language: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString()
}

const selectedWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: '(no-worktree)',
  branch_name: null,
  path: '/repo/project-1',
  status: 'active' as const,
  is_default: true,
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString()
}

const otherWorktree = {
  id: 'worktree-2',
  project_id: 'project-1',
  name: 'feature-a',
  branch_name: 'feature-a',
  path: '/repo/project-1/.hive-worktrees/feature-a',
  status: 'active' as const,
  is_default: false,
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString()
}

const activeSessionOnOtherWorktree = {
  id: 'session-2',
  worktree_id: 'worktree-2',
  project_id: 'project-1',
  name: 'Existing Session',
  status: 'active' as const,
  opencode_session_id: null,
  mode: 'build' as const,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null
}

describe('Session 9: SessionTabs auto-start behavior', () => {
  const mockCreateSession = vi.fn()
  const mockLoadSessions = vi.fn()
  const mockGetByProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    mockCreateSession.mockResolvedValue({ success: true })
    mockLoadSessions.mockResolvedValue(undefined)

    useSessionStore.setState((state) => ({
      ...state,
      activeWorktreeId: 'worktree-1',
      activeSessionId: null,
      isLoading: false,
      sessionsByWorktree: new Map([['worktree-1', []]]),
      tabOrderByWorktree: new Map([['worktree-1', []]]),
      createSession: mockCreateSession,
      loadSessions: mockLoadSessions
    }))

    useWorktreeStore.setState((state) => ({
      ...state,
      selectedWorktreeId: 'worktree-1',
      worktreesByProject: new Map([['project-1', [selectedWorktree, otherWorktree]]])
    }))

    useProjectStore.setState((state) => ({
      ...state,
      projects: [project],
      selectedProjectId: 'project-1'
    }))

    useFileViewerStore.setState((state) => ({
      ...state,
      activeFilePath: null,
      openFiles: new Map()
    }))

    useSettingsStore.setState((state) => ({
      ...state,
      autoStartSession: true,
      isLoading: false
    }))

    Object.defineProperty(window, 'db', {
      value: {
        session: {
          getByProject: mockGetByProject
        },
        setting: {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue(true)
        }
      },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('does not auto-create when project already has active sessions in another worktree', async () => {
    mockGetByProject.mockResolvedValue([activeSessionOnOtherWorktree])

    render(<SessionTabs />)

    await waitFor(() => {
      expect(mockGetByProject).toHaveBeenCalledWith('project-1')
    })

    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  test('auto-creates when project has no active sessions at all', async () => {
    mockGetByProject.mockResolvedValue([])

    render(<SessionTabs />)

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith('worktree-1', 'project-1')
    })
  })
})
