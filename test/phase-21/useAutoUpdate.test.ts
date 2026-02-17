import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

// vi.hoisted so mock refs are accessible inside vi.mock factories
const { mockCustom, mockSuccess, mockError, mockDismiss } = vi.hoisted(() => ({
  mockCustom: vi.fn().mockReturnValue('progress-toast-id'),
  mockSuccess: vi.fn().mockReturnValue('success-id'),
  mockError: vi.fn().mockReturnValue('error-id'),
  mockDismiss: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: mockSuccess,
    error: mockError,
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: mockDismiss,
    custom: mockCustom
  }),
  ExternalToast: {}
}))

// Mock lucide-react (used by @/lib/toast wrapper)
vi.mock('lucide-react', () => ({
  CheckCircle2: 'CheckCircle2',
  XCircle: 'XCircle',
  Info: 'Info',
  AlertTriangle: 'AlertTriangle',
  Download: 'Download'
}))

// Store listener callbacks so tests can invoke them
const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

function addListener(event: string, cb: (...args: unknown[]) => void): () => void {
  if (!listeners[event]) listeners[event] = []
  listeners[event].push(cb)
  return () => {
    listeners[event] = listeners[event].filter((l) => l !== cb)
  }
}

function emit(event: string, data: unknown): void {
  ;(listeners[event] || []).forEach((cb) => cb(data))
}

const mockUpdaterOps = {
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  setChannel: vi.fn(),
  getVersion: vi.fn(),
  onChecking: vi.fn((cb) => addListener('checking', cb)),
  onUpdateAvailable: vi.fn((cb) => addListener('available', cb)),
  onUpdateNotAvailable: vi.fn((cb) => addListener('not-available', cb)),
  onProgress: vi.fn((cb) => addListener('progress', cb)),
  onUpdateDownloaded: vi.fn((cb) => addListener('downloaded', cb)),
  onError: vi.fn((cb) => addListener('error', cb))
}

Object.defineProperty(window, 'updaterOps', {
  writable: true,
  configurable: true,
  value: mockUpdaterOps
})

// Import after mocks are set up
const { useAutoUpdate } = await import('@/hooks/useAutoUpdate')

describe('useAutoUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(listeners).forEach((k) => delete listeners[k])
  })

  it('shows progress toast when update is available', () => {
    renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })

    expect(mockCustom).toHaveBeenCalledWith(
      expect.any(Function),
      { duration: Infinity }
    )
    cleanup()
  })

  it('updates progress toast in-place on download progress', () => {
    renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })
    mockCustom.mockClear()

    emit('progress', { percent: 50, bytesPerSecond: 1000, transferred: 500, total: 1000 })

    expect(mockCustom).toHaveBeenCalledWith(
      expect.any(Function),
      { id: 'progress-toast-id', duration: Infinity }
    )
    cleanup()
  })

  it('dismisses progress toast when download completes', () => {
    renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })
    emit('downloaded', { version: '2.0.0' })

    expect(mockDismiss).toHaveBeenCalledWith('progress-toast-id')
    cleanup()
  })

  it('shows restart prompt after download completes', () => {
    renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })
    emit('downloaded', { version: '2.0.0' })

    expect(mockSuccess).toHaveBeenCalledWith(
      'Update v2.0.0 ready to install',
      expect.objectContaining({
        duration: Infinity,
        action: expect.objectContaining({ label: 'Restart to Update' })
      })
    )
    cleanup()
  })

  it('dismisses progress toast on error', () => {
    renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })
    emit('error', { message: 'Network failed' })

    expect(mockDismiss).toHaveBeenCalledWith('progress-toast-id')
    expect(mockError).toHaveBeenCalledWith(
      'Update check failed',
      expect.objectContaining({ description: 'Network failed' })
    )
    cleanup()
  })

  it('does not crash on progress event without prior available event', () => {
    renderHook(() => useAutoUpdate())

    expect(() => {
      emit('progress', { percent: 50, bytesPerSecond: 1000, transferred: 500, total: 1000 })
    }).not.toThrow()
    expect(mockCustom).not.toHaveBeenCalled()
    cleanup()
  })

  it('cleans up progress toast on unmount', () => {
    const { unmount } = renderHook(() => useAutoUpdate())

    emit('available', { version: '2.0.0' })
    unmount()

    expect(mockDismiss).toHaveBeenCalledWith('progress-toast-id')
    cleanup()
  })
})
