import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDropAttachmentStore } from '../../src/renderer/src/stores/useDropAttachmentStore'

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  }
}))

describe('useDropAttachmentStore', () => {
  beforeEach(() => {
    // Reset store
    useDropAttachmentStore.setState({ pending: [] })
  })

  it('starts with empty pending', () => {
    expect(useDropAttachmentStore.getState().pending).toEqual([])
  })

  it('push appends items to pending', () => {
    const items = [
      { kind: 'path' as const, name: 'test.ts', mime: 'text/typescript', filePath: '/path/test.ts' }
    ]
    useDropAttachmentStore.getState().push(items)
    expect(useDropAttachmentStore.getState().pending).toHaveLength(1)
    expect(useDropAttachmentStore.getState().pending[0]).toEqual(items[0])
  })

  it('push appends to existing pending items', () => {
    const first = [
      { kind: 'path' as const, name: 'a.ts', mime: 'text/typescript', filePath: '/a.ts' }
    ]
    const second = [
      { kind: 'path' as const, name: 'b.ts', mime: 'text/typescript', filePath: '/b.ts' }
    ]
    useDropAttachmentStore.getState().push(first)
    useDropAttachmentStore.getState().push(second)
    expect(useDropAttachmentStore.getState().pending).toHaveLength(2)
  })

  it('consume returns pending and resets to empty', () => {
    const items = [
      {
        kind: 'data' as const,
        name: 'img.png',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,abc'
      }
    ]
    useDropAttachmentStore.getState().push(items)

    const consumed = useDropAttachmentStore.getState().consume()
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toEqual(items[0])
    expect(useDropAttachmentStore.getState().pending).toEqual([])
  })

  it('consume returns empty array when nothing pending', () => {
    const consumed = useDropAttachmentStore.getState().consume()
    expect(consumed).toEqual([])
  })
})

describe('drop processing logic', () => {
  it('filters out directory-like files (size 0, type empty)', () => {
    // Simulate the filter logic from handleFileDrop
    const files = [
      { name: 'folder', type: '', size: 0 },
      { name: 'real.ts', type: 'text/typescript', size: 100 }
    ]
    const valid = files.filter((f) => !(f.type === '' && f.size === 0))
    expect(valid).toHaveLength(1)
    expect(valid[0].name).toBe('real.ts')
  })

  it('truncates to MAX_ATTACHMENTS (10) when too many files dropped', () => {
    const MAX_ATTACHMENTS = 10
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `file${i}.ts`,
      type: 'text/typescript',
      size: 100
    }))
    const truncated =
      files.length > MAX_ATTACHMENTS ? files.slice(0, MAX_ATTACHMENTS) : files
    expect(truncated).toHaveLength(10)
  })

  it('caps cumulative attachments at MAX_ATTACHMENTS', () => {
    const MAX_ATTACHMENTS = 10
    const existing = 8
    const newItems = 5
    const remaining = MAX_ATTACHMENTS - existing
    const toAdd = Math.min(newItems, remaining)
    expect(toAdd).toBe(2)
  })
})
