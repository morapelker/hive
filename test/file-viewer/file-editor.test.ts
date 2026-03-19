import { describe, it, expect, beforeEach } from 'vitest'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { getLanguageExtension } from '@/components/file-viewer/cm-languages'

// Reset store state before each test
beforeEach(() => {
  useFileViewerStore.setState({
    openFiles: new Map(),
    activeFilePath: null,
    activeDiff: null,
    dirtyFiles: new Set(),
    originalContents: new Map(),
    pendingClose: null,
    externallyChanged: new Set(),
    contextEditorWorktreeId: null
  })
})

describe('useFileViewerStore — dirty state tracking', () => {
  it('markDirty adds a file to dirtyFiles', () => {
    const store = useFileViewerStore.getState()
    store.markDirty('/test/file.ts')
    expect(useFileViewerStore.getState().dirtyFiles.has('/test/file.ts')).toBe(true)
  })

  it('markClean removes a file from dirtyFiles', () => {
    const store = useFileViewerStore.getState()
    store.markDirty('/test/file.ts')
    store.markClean('/test/file.ts')
    expect(useFileViewerStore.getState().dirtyFiles.has('/test/file.ts')).toBe(false)
  })

  it('isDirty returns correct state', () => {
    const store = useFileViewerStore.getState()
    expect(store.isDirty('/test/file.ts')).toBe(false)
    store.markDirty('/test/file.ts')
    expect(useFileViewerStore.getState().isDirty('/test/file.ts')).toBe(true)
    useFileViewerStore.getState().markClean('/test/file.ts')
    expect(useFileViewerStore.getState().isDirty('/test/file.ts')).toBe(false)
  })
})

describe('useFileViewerStore — original content', () => {
  it('setOriginalContent stores content and getOriginalContent retrieves it', () => {
    const store = useFileViewerStore.getState()
    store.setOriginalContent('/test/file.ts', 'const x = 1')
    expect(useFileViewerStore.getState().getOriginalContent('/test/file.ts')).toBe('const x = 1')
  })

  it('getOriginalContent returns undefined for unknown files', () => {
    expect(useFileViewerStore.getState().getOriginalContent('/unknown')).toBeUndefined()
  })
})

describe('useFileViewerStore — requestCloseFile', () => {
  it('clean file closes immediately', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/test/file.ts', 'file.ts', 'wt1')
    expect(useFileViewerStore.getState().openFiles.has('/test/file.ts')).toBe(true)

    useFileViewerStore.getState().requestCloseFile('/test/file.ts')
    const state = useFileViewerStore.getState()
    expect(state.openFiles.has('/test/file.ts')).toBe(false)
    expect(state.pendingClose).toBeNull()
  })

  it('dirty file sets pendingClose instead of closing', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/test/file.ts', 'file.ts', 'wt1')
    store.markDirty('/test/file.ts')

    useFileViewerStore.getState().requestCloseFile('/test/file.ts')
    const state = useFileViewerStore.getState()
    expect(state.openFiles.has('/test/file.ts')).toBe(true)
    expect(state.pendingClose).toBe('/test/file.ts')
  })
})

describe('useFileViewerStore — confirmCloseFile', () => {
  it('clears dirty, originalContents, pendingClose, and closes tab', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/test/file.ts', 'file.ts', 'wt1')
    store.markDirty('/test/file.ts')
    store.setOriginalContent('/test/file.ts', 'original')

    useFileViewerStore.getState().requestCloseFile('/test/file.ts')
    expect(useFileViewerStore.getState().pendingClose).toBe('/test/file.ts')

    useFileViewerStore.getState().confirmCloseFile('/test/file.ts')
    const state = useFileViewerStore.getState()
    expect(state.dirtyFiles.has('/test/file.ts')).toBe(false)
    expect(state.originalContents.has('/test/file.ts')).toBe(false)
    expect(state.pendingClose).toBeNull()
    expect(state.openFiles.has('/test/file.ts')).toBe(false)
  })
})

describe('useFileViewerStore — cancelCloseFile', () => {
  it('clears pendingClose without closing the tab', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/test/file.ts', 'file.ts', 'wt1')
    store.markDirty('/test/file.ts')

    useFileViewerStore.getState().requestCloseFile('/test/file.ts')
    expect(useFileViewerStore.getState().pendingClose).toBe('/test/file.ts')

    useFileViewerStore.getState().cancelCloseFile()
    const state = useFileViewerStore.getState()
    expect(state.pendingClose).toBeNull()
    expect(state.openFiles.has('/test/file.ts')).toBe(true)
  })
})

describe('useFileViewerStore — external changes', () => {
  it('markExternallyChanged adds file to set', () => {
    useFileViewerStore.getState().markExternallyChanged('/test/file.ts')
    expect(useFileViewerStore.getState().externallyChanged.has('/test/file.ts')).toBe(true)
  })

  it('clearExternallyChanged removes file from set', () => {
    useFileViewerStore.getState().markExternallyChanged('/test/file.ts')
    useFileViewerStore.getState().clearExternallyChanged('/test/file.ts')
    expect(useFileViewerStore.getState().externallyChanged.has('/test/file.ts')).toBe(false)
  })
})

describe('useFileViewerStore — bulk close cleanup', () => {
  it('closeAllFiles clears dirty, originalContents, and externallyChanged', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/a.ts', 'a.ts', 'wt1')
    store.openFile('/b.ts', 'b.ts', 'wt1')
    store.markDirty('/a.ts')
    store.setOriginalContent('/a.ts', 'original-a')
    store.markExternallyChanged('/b.ts')

    useFileViewerStore.getState().closeAllFiles()
    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(0)
    expect(state.dirtyFiles.size).toBe(0)
    expect(state.originalContents.size).toBe(0)
    expect(state.externallyChanged.size).toBe(0)
    expect(state.pendingClose).toBeNull()
  })

  it('closeOtherFiles cleans up state for closed files only', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/a.ts', 'a.ts', 'wt1')
    store.openFile('/b.ts', 'b.ts', 'wt1')
    store.openFile('/c.ts', 'c.ts', 'wt1')
    store.markDirty('/a.ts')
    store.setOriginalContent('/a.ts', 'orig-a')
    store.markDirty('/b.ts')
    store.setOriginalContent('/b.ts', 'orig-b')
    store.markExternallyChanged('/c.ts')

    useFileViewerStore.getState().closeOtherFiles('/b.ts')
    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(1)
    expect(state.openFiles.has('/b.ts')).toBe(true)
    // /a.ts and /c.ts state should be cleaned up
    expect(state.dirtyFiles.has('/a.ts')).toBe(false)
    expect(state.originalContents.has('/a.ts')).toBe(false)
    expect(state.externallyChanged.has('/c.ts')).toBe(false)
    // /b.ts state should be preserved
    expect(state.dirtyFiles.has('/b.ts')).toBe(true)
    expect(state.originalContents.has('/b.ts')).toBe(true)
  })

  it('closeFilesToRight cleans up state for closed files only', () => {
    const store = useFileViewerStore.getState()
    store.openFile('/a.ts', 'a.ts', 'wt1')
    store.openFile('/b.ts', 'b.ts', 'wt1')
    store.openFile('/c.ts', 'c.ts', 'wt1')
    store.markDirty('/c.ts')
    store.setOriginalContent('/c.ts', 'orig-c')
    store.markExternallyChanged('/c.ts')

    useFileViewerStore.getState().closeFilesToRight('/a.ts')
    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(1)
    expect(state.openFiles.has('/a.ts')).toBe(true)
    // /b.ts and /c.ts should be cleaned up
    expect(state.dirtyFiles.has('/c.ts')).toBe(false)
    expect(state.originalContents.has('/c.ts')).toBe(false)
    expect(state.externallyChanged.has('/c.ts')).toBe(false)
  })
})

describe('cm-languages — getLanguageExtension', () => {
  it('returns a non-empty Extension for .ts files', () => {
    const ext = getLanguageExtension('file.ts')
    expect(ext).toBeDefined()
    expect(Array.isArray(ext) && ext.length === 0).toBe(false)
  })

  it('returns a non-empty Extension for .py files', () => {
    const ext = getLanguageExtension('file.py')
    expect(ext).toBeDefined()
    expect(Array.isArray(ext) && ext.length === 0).toBe(false)
  })

  it('returns empty array for unknown extensions', () => {
    const ext = getLanguageExtension('file.unknown')
    expect(ext).toEqual([])
  })

  it('returns extensions for various file types', () => {
    const cases = [
      '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html',
      '.xml', '.svg', '.rs', '.java', '.cpp', '.sql'
    ]
    for (const c of cases) {
      const ext = getLanguageExtension(`test${c}`)
      expect(ext).toBeDefined()
      // Non-empty: not an empty array
      const isEmpty = Array.isArray(ext) && ext.length === 0
      expect(isEmpty).toBe(false)
    }
  })

  it('handles full file paths, not just extensions', () => {
    const ext = getLanguageExtension('/path/to/deep/file.ts')
    expect(ext).toBeDefined()
    expect(Array.isArray(ext) && ext.length === 0).toBe(false)
  })
})
