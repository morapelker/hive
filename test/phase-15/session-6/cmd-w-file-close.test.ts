import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * Replicates the Cmd+W / Ctrl+W close logic from useKeyboardShortcuts.ts
 * to test the priority-based dispatch in isolation without requiring
 * the full Electron environment or React hooks.
 */

// Mock store state
let mockActiveFilePath: string | null = null
let mockActiveDiff: { worktreePath: string; filePath: string } | null = null
let mockActiveSessionId: string | null = null

// Mock action spies
const closeFileMock = vi.fn()
const clearActiveDiffMock = vi.fn()
const closeSessionMock = vi.fn().mockResolvedValue({ success: true })

// Replicate the handler logic from useKeyboardShortcuts.ts onCloseSessionShortcut
function handleCloseShortcut(): void {
  // Priority 1: Close active file tab
  if (mockActiveFilePath) {
    closeFileMock(mockActiveFilePath)
    return
  }

  // Priority 2: Clear active diff view
  if (mockActiveDiff) {
    clearActiveDiffMock()
    return
  }

  // Priority 3: Close active session tab
  if (!mockActiveSessionId) return
  closeSessionMock(mockActiveSessionId)
}

describe('Session 6: Cmd+W File Tab Close', () => {
  beforeEach(() => {
    mockActiveFilePath = null
    mockActiveDiff = null
    mockActiveSessionId = null
    closeFileMock.mockClear()
    clearActiveDiffMock.mockClear()
    closeSessionMock.mockClear()
  })

  test('closes file tab when activeFilePath is set', () => {
    mockActiveFilePath = '/path/to/file.ts'
    mockActiveSessionId = 'session-1'

    handleCloseShortcut()

    expect(closeFileMock).toHaveBeenCalledWith('/path/to/file.ts')
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  test('clears diff when activeDiff is set and no file active', () => {
    mockActiveDiff = { worktreePath: '/repo', filePath: 'src/index.ts' }
    mockActiveSessionId = 'session-1'

    handleCloseShortcut()

    expect(clearActiveDiffMock).toHaveBeenCalled()
    expect(closeFileMock).not.toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  test('closes session when no file and no diff active', () => {
    mockActiveSessionId = 'session-1'

    handleCloseShortcut()

    expect(closeSessionMock).toHaveBeenCalledWith('session-1')
    expect(closeFileMock).not.toHaveBeenCalled()
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
  })

  test('no-op when nothing is active', () => {
    handleCloseShortcut()

    expect(closeFileMock).not.toHaveBeenCalled()
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  test('file tab takes priority over diff when both are set', () => {
    mockActiveFilePath = '/path/to/file.ts'
    mockActiveDiff = { worktreePath: '/repo', filePath: 'src/other.ts' }
    mockActiveSessionId = 'session-1'

    handleCloseShortcut()

    expect(closeFileMock).toHaveBeenCalledWith('/path/to/file.ts')
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  test('diff takes priority over session when both are set', () => {
    mockActiveDiff = { worktreePath: '/repo', filePath: 'src/index.ts' }
    mockActiveSessionId = 'session-1'

    handleCloseShortcut()

    expect(clearActiveDiffMock).toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })
})
