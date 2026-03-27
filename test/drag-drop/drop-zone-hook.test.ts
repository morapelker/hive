import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDropZone } from '../../src/renderer/src/hooks/useDropZone'

describe('useDropZone', () => {
  let onDrop: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onDrop = vi.fn()
  })

  const createDragEvent = (type: string, options: Partial<DragEvent> = {}) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = new Event(type, { bubbles: true }) as any
    event.preventDefault = vi.fn()
    event.dataTransfer = {
      types: ['Files'],
      files: [],
      dropEffect: 'none',
      ...options
    }
    return event
  }

  it('sets isDragging to true on dragenter with Files type', () => {
    const { result } = renderHook(() => useDropZone({ onDrop }))
    expect(result.current.isDragging).toBe(false)

    act(() => {
      window.dispatchEvent(createDragEvent('dragenter'))
    })

    expect(result.current.isDragging).toBe(true)
  })

  it('sets isDragging to false on dragleave after dragenter', () => {
    const { result } = renderHook(() => useDropZone({ onDrop }))

    act(() => {
      window.dispatchEvent(createDragEvent('dragenter'))
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      window.dispatchEvent(createDragEvent('dragleave'))
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('ignores dragenter without Files type (internal drags)', () => {
    const { result } = renderHook(() => useDropZone({ onDrop }))

    const event = createDragEvent('dragenter')
    event.dataTransfer.types = ['text/plain']

    act(() => {
      window.dispatchEvent(event)
    })

    expect(result.current.isDragging).toBe(false)
  })

  it('calls onDrop and resets isDragging on drop', () => {
    const { result } = renderHook(() => useDropZone({ onDrop }))
    const mockFiles = [new File(['content'], 'test.txt', { type: 'text/plain' })]
    const fileList = {
      length: 1,
      0: mockFiles[0],
      item: (i: number) => mockFiles[i]
    } as unknown as FileList

    act(() => {
      window.dispatchEvent(createDragEvent('dragenter'))
    })
    expect(result.current.isDragging).toBe(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropEvent = createDragEvent('drop', { files: fileList } as any)
    dropEvent.dataTransfer.files = fileList

    act(() => {
      window.dispatchEvent(dropEvent)
    })

    expect(result.current.isDragging).toBe(false)
    expect(onDrop).toHaveBeenCalledWith(fileList)
  })

  it('handles nested element flickering (enter -> enter -> leave -> still dragging)', () => {
    const { result } = renderHook(() => useDropZone({ onDrop }))

    act(() => {
      window.dispatchEvent(createDragEvent('dragenter'))
    })
    act(() => {
      window.dispatchEvent(createDragEvent('dragenter'))
    })
    act(() => {
      window.dispatchEvent(createDragEvent('dragleave'))
    })

    // Counter should be 1, still dragging
    expect(result.current.isDragging).toBe(true)
  })
})
