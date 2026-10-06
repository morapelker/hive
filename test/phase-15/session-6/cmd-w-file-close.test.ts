import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * Replicates the Cmd+W / Ctrl+W close logic from useKeyboardShortcuts.ts
 * to test the priority-based dispatch in isolation without requiring
 * the full Electron environment or React hooks.
 */

// Mock store state
let mockActiveFilePath: string | null = null
let mockActiveDiff: { worktreePath: string; filePath: string } | null = null

// Mock action spies
const closeFileMock = vi.fn()
const clearActiveDiffMock = vi.fn()

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
  }

  // Session tabs are never closed by Cmd+W
}

describe('Session 6: Cmd+W File Tab Close', () => {
  beforeEach(() => {
    mockActiveFilePath = null
    mockActiveDiff = null
    closeFileMock.mockClear()
    clearActiveDiffMock.mockClear()
  })

  test('closes file tab when activeFilePath is set', () => {
    mockActiveFilePath = '/path/to/file.ts'

    handleCloseShortcut()

    expect(closeFileMock).toHaveBeenCalledWith('/path/to/file.ts')
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
  })

  test('clears diff when activeDiff is set and no file active', () => {
    mockActiveDiff = { worktreePath: '/repo', filePath: 'src/index.ts' }

    handleCloseShortcut()

    expect(clearActiveDiffMock).toHaveBeenCalled()
    expect(closeFileMock).not.toHaveBeenCalled()
  })

  test('no-op when no file or diff is active (the session stays open)', () => {
    handleCloseShortcut()

    expect(closeFileMock).not.toHaveBeenCalled()
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
  })

  test('file tab takes priority over diff when both are set', () => {
    mockActiveFilePath = '/path/to/file.ts'
    mockActiveDiff = { worktreePath: '/repo', filePath: 'src/other.ts' }

    handleCloseShortcut()

    expect(closeFileMock).toHaveBeenCalledWith('/path/to/file.ts')
    expect(clearActiveDiffMock).not.toHaveBeenCalled()
  })
})
