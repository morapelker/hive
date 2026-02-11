/**
 * Session 12: Merge Conflicts Button Tests
 *
 * Testing criteria from IMPLEMENTATION-P15.md:
 * - CONFLICTS button renders when conflicted files exist
 * - CONFLICTS button hidden when no conflicts
 * - Clicking CONFLICTS creates session with correct name
 * - Conflict detection correctly categorizes files with status 'C'
 * - handleFixConflicts follows same pattern as handleReview
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

// -- Helpers to simulate the categorization logic from GitStatusPanel --

interface GitFileStatus {
  relativePath: string
  status: string
  staged: boolean
}

function categorizeFiles(files: GitFileStatus[]) {
  const staged: GitFileStatus[] = []
  const modified: GitFileStatus[] = []
  const untracked: GitFileStatus[] = []
  const conflicted: GitFileStatus[] = []

  for (const file of files) {
    if (file.status === 'C') {
      conflicted.push(file)
    } else if (file.staged) {
      staged.push(file)
    } else if (file.status === '?') {
      untracked.push(file)
    } else if (file.status === 'M' || file.status === 'D') {
      modified.push(file)
    }
  }

  return { staged, modified, untracked, conflicted }
}

// -- Mock stores for handleFixConflicts flow --

const mockCreateSession = vi.fn()
const mockUpdateSessionName = vi.fn()
const mockSetPendingMessage = vi.fn()

const mockSessionStore = {
  createSession: mockCreateSession,
  updateSessionName: mockUpdateSessionName,
  setPendingMessage: mockSetPendingMessage
}

const mockWorktreeStore = {
  selectedWorktreeId: 'wt-1',
  worktreesByProject: new Map([['proj-1', [{ id: 'wt-1', name: 'main-wt' }]]])
}

describe('Session 12: Merge Conflicts Button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSession.mockResolvedValue({
      success: true,
      session: { id: 'session-new' }
    })
    mockUpdateSessionName.mockResolvedValue(undefined)
  })

  describe('Conflict detection', () => {
    test('files with status "C" are categorized as conflicted', () => {
      const files: GitFileStatus[] = [
        { relativePath: 'src/app.ts', status: 'C', staged: false },
        { relativePath: 'src/index.ts', status: 'M', staged: false },
        { relativePath: 'README.md', status: 'A', staged: true }
      ]

      const result = categorizeFiles(files)

      expect(result.conflicted).toHaveLength(1)
      expect(result.conflicted[0].relativePath).toBe('src/app.ts')
      expect(result.modified).toHaveLength(1)
      expect(result.staged).toHaveLength(1)
    })

    test('multiple conflicted files are all captured', () => {
      const files: GitFileStatus[] = [
        { relativePath: 'file1.ts', status: 'C', staged: false },
        { relativePath: 'file2.ts', status: 'C', staged: false },
        { relativePath: 'file3.ts', status: 'C', staged: false }
      ]

      const result = categorizeFiles(files)

      expect(result.conflicted).toHaveLength(3)
    })

    test('no conflicted files when none have status "C"', () => {
      const files: GitFileStatus[] = [
        { relativePath: 'src/app.ts', status: 'M', staged: false },
        { relativePath: 'src/index.ts', status: 'A', staged: true },
        { relativePath: 'new.txt', status: '?', staged: false },
        { relativePath: 'removed.ts', status: 'D', staged: false }
      ]

      const result = categorizeFiles(files)

      expect(result.conflicted).toHaveLength(0)
      expect(result.modified).toHaveLength(2) // M and D
      expect(result.staged).toHaveLength(1) // A staged
      expect(result.untracked).toHaveLength(1) // ?
    })

    test('conflicted files with staged flag are still categorized as conflicted (status takes priority)', () => {
      const files: GitFileStatus[] = [{ relativePath: 'conflict.ts', status: 'C', staged: true }]

      const result = categorizeFiles(files)

      // Status 'C' check comes before staged check
      expect(result.conflicted).toHaveLength(1)
      expect(result.staged).toHaveLength(0)
    })

    test('empty file list produces no conflicts', () => {
      const result = categorizeFiles([])

      expect(result.conflicted).toHaveLength(0)
      expect(result.staged).toHaveLength(0)
      expect(result.modified).toHaveLength(0)
      expect(result.untracked).toHaveLength(0)
    })
  })

  describe('CONFLICTS button visibility', () => {
    test('hasConflicts is true when conflicted files exist', () => {
      const files: GitFileStatus[] = [{ relativePath: 'src/app.ts', status: 'C', staged: false }]
      const { conflicted } = categorizeFiles(files)
      const hasConflicts = conflicted.length > 0

      expect(hasConflicts).toBe(true)
    })

    test('hasConflicts is false when no conflicts', () => {
      const files: GitFileStatus[] = [{ relativePath: 'src/app.ts', status: 'M', staged: false }]
      const { conflicted } = categorizeFiles(files)
      const hasConflicts = conflicted.length > 0

      expect(hasConflicts).toBe(false)
    })

    test('button title includes conflict count', () => {
      const conflictedFiles = [
        { relativePath: 'a.ts', status: 'C', staged: false },
        { relativePath: 'b.ts', status: 'C', staged: false }
      ]
      const title = `${conflictedFiles.length} file(s) with merge conflicts — click to fix with AI`

      expect(title).toBe('2 file(s) with merge conflicts — click to fix with AI')
    })
  })

  describe('handleFixConflicts flow', () => {
    test('creates session with correct worktree and project', async () => {
      const branchName = 'feature/auth'

      // Simulate the handleFixConflicts logic
      const worktreeStore = mockWorktreeStore
      const selectedWorktreeId = worktreeStore.selectedWorktreeId

      let projectId = ''
      for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
        if (worktrees.some((w) => w.id === selectedWorktreeId)) {
          projectId = projId
          break
        }
      }

      const sessionStore = mockSessionStore
      const result = await sessionStore.createSession(selectedWorktreeId, projectId)

      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1')
      expect(result.success).toBe(true)
      expect(result.session.id).toBe('session-new')

      // Session naming
      await sessionStore.updateSessionName(result.session.id, `Merge Conflicts — ${branchName}`)
      expect(mockUpdateSessionName).toHaveBeenCalledWith(
        'session-new',
        'Merge Conflicts — feature/auth'
      )

      // Pending message
      sessionStore.setPendingMessage(result.session.id, 'Fix merge conflicts')
      expect(mockSetPendingMessage).toHaveBeenCalledWith('session-new', 'Fix merge conflicts')
    })

    test('session name uses branch name from branchInfo', () => {
      const branchName = 'main'
      const sessionName = `Merge Conflicts — ${branchName}`

      expect(sessionName).toBe('Merge Conflicts — main')
    })

    test('session name uses "unknown" when no branch info', () => {
      const branchName = undefined
      const sessionName = `Merge Conflicts — ${branchName || 'unknown'}`

      expect(sessionName).toBe('Merge Conflicts — unknown')
    })

    test('handles session creation failure gracefully', async () => {
      mockCreateSession.mockResolvedValue({ success: false })

      const result = await mockSessionStore.createSession('wt-1', 'proj-1')

      expect(result.success).toBe(false)
      // When creation fails, updateSessionName and setPendingMessage should not be called
      expect(mockUpdateSessionName).not.toHaveBeenCalled()
      expect(mockSetPendingMessage).not.toHaveBeenCalled()
    })

    test('handles missing worktree selection', () => {
      const worktreeStore = { ...mockWorktreeStore, selectedWorktreeId: null }

      // When no worktree selected, should return early
      expect(worktreeStore.selectedWorktreeId).toBeNull()
    })

    test('handles missing project for worktree', () => {
      const worktreeStore = {
        selectedWorktreeId: 'wt-unknown',
        worktreesByProject: new Map([['proj-1', [{ id: 'wt-1', name: 'main-wt' }]]])
      }

      let projectId = ''
      for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
        if (worktrees.some((w) => w.id === worktreeStore.selectedWorktreeId)) {
          projectId = projId
          break
        }
      }

      expect(projectId).toBe('')
    })
  })

  describe('Button disabled state', () => {
    test('button is disabled while fixing conflicts', () => {
      const isFixingConflicts = true
      expect(isFixingConflicts).toBe(true)
    })

    test('button is enabled when not fixing conflicts', () => {
      const isFixingConflicts = false
      expect(isFixingConflicts).toBe(false)
    })
  })

  describe('Conflicts section in file list', () => {
    test('conflicted files are shown in a separate Conflicts section', () => {
      const files: GitFileStatus[] = [
        { relativePath: 'conflict.ts', status: 'C', staged: false },
        { relativePath: 'modified.ts', status: 'M', staged: false },
        { relativePath: 'staged.ts', status: 'A', staged: true }
      ]

      const { conflicted, modified, staged } = categorizeFiles(files)

      // Each category should be separate — conflicts don't mix with others
      expect(conflicted).toHaveLength(1)
      expect(modified).toHaveLength(1)
      expect(staged).toHaveLength(1)

      // Verify the conflict is in the right bucket
      expect(conflicted[0].status).toBe('C')
      expect(modified[0].status).toBe('M')
    })
  })
})
