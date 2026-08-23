import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFileTabState } from '../useFileTabState'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

const isWindows = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/lib/platform', () => ({ isWindows }))

describe('useFileTabState', () => {
  beforeEach(() => {
    isWindows.mockReturnValue(false)
    useFileViewerStore.getState().closeAllFiles()
  })

  afterEach(() => {
    cleanup()
    useFileViewerStore.getState().closeAllFiles()
  })

  it('returns null when the file has no tab', () => {
    const { result } = renderHook(() => useFileTabState('/wt/src/a.ts'))
    expect(result.current).toBeNull()
  })

  it('returns null for rows without a path, like folders', () => {
    useFileViewerStore.getState().openFile('/wt/src/a.ts', 'a.ts', 'wt-1')

    const { result } = renderHook(() => useFileTabState(null))
    expect(result.current).toBeNull()
  })

  it('marks the file tab that is active', () => {
    useFileViewerStore.getState().openFile('/wt/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().openFile('/wt/src/b.ts', 'b.ts', 'wt-1')

    expect(renderHook(() => useFileTabState('/wt/src/b.ts')).result.current).toBe('active')
    expect(renderHook(() => useFileTabState('/wt/src/a.ts')).result.current).toBe('open')
  })

  it('resolves a diff tab to the absolute path of its file', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/wt',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    const { result } = renderHook(() => useFileTabState('/wt/src/a.ts'))
    expect(result.current).toBe('active')
  })

  it('matches a row whose path uses the other separator on Windows', () => {
    // Rows get native paths from the backend, but a tab can be opened with a
    // slash separated one, so on Windows both spellings mean the same file.
    isWindows.mockReturnValue(true)
    useFileViewerStore.getState().openFile('C:\\wt/src/a.ts', 'a.ts', 'wt-1')

    const { result } = renderHook(() => useFileTabState('C:\\wt\\src\\a.ts'))
    expect(result.current).toBe('active')
  })

  it('keeps a backslash filename distinct off Windows', () => {
    useFileViewerStore.getState().openFile('/wt/a\\b.ts', 'a\\b.ts', 'wt-1')

    const { result } = renderHook(() => useFileTabState('/wt/a/b.ts'))
    expect(result.current).toBeNull()
  })

  it('ignores context tabs', () => {
    useFileViewerStore.getState().openContextEditor('wt-1')

    const { result } = renderHook(() => useFileTabState('/wt/src/a.ts'))
    expect(result.current).toBeNull()
  })
})
