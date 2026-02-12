import { describe, test, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted — use vi.hoisted to create mock refs accessible inside the factory
const { mockSuccess, mockError, mockWarning, mockInfo } = vi.hoisted(() => ({
  mockSuccess: vi.fn().mockReturnValue(1),
  mockError: vi.fn().mockReturnValue(2),
  mockWarning: vi.fn().mockReturnValue(3),
  mockInfo: vi.fn().mockReturnValue(4)
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn().mockReturnValue(0), {
    success: mockSuccess,
    error: mockError,
    warning: mockWarning,
    info: mockInfo,
    loading: vi.fn().mockReturnValue(5),
    promise: vi.fn(),
    dismiss: vi.fn()
  }),
  ExternalToast: {}
}))

// Mock lucide-react to avoid JSX rendering issues
vi.mock('lucide-react', () => ({
  CheckCircle2: 'CheckCircle2',
  XCircle: 'XCircle',
  Info: 'Info',
  AlertTriangle: 'AlertTriangle'
}))

import { toast } from '../../../src/renderer/src/lib/toast'

describe('Session 1: Toast Variants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('toast.success calls sonnerToast.success with green CheckCircle2 icon', () => {
    toast.success('Done')

    expect(mockSuccess).toHaveBeenCalledOnce()
    const [message, options] = mockSuccess.mock.calls[0]
    expect(message).toBe('Done')
    expect(options.duration).toBe(3000)
    expect(options.icon).toBeDefined()
    expect(options.icon.type).toBe('CheckCircle2')
    expect(options.icon.props.className).toContain('text-green-500')
  })

  test('toast.error calls sonnerToast.error with red XCircle icon', () => {
    toast.error('Failed')

    expect(mockError).toHaveBeenCalledOnce()
    const [message, options] = mockError.mock.calls[0]
    expect(message).toBe('Failed')
    expect(options.duration).toBe(5000)
    expect(options.icon).toBeDefined()
    expect(options.icon.type).toBe('XCircle')
    expect(options.icon.props.className).toContain('text-red-500')
  })

  test('toast.info calls sonnerToast.info with blue Info icon', () => {
    toast.info('Note')

    expect(mockInfo).toHaveBeenCalledOnce()
    const [message, options] = mockInfo.mock.calls[0]
    expect(message).toBe('Note')
    expect(options.duration).toBe(3000)
    expect(options.icon).toBeDefined()
    expect(options.icon.type).toBe('Info')
    expect(options.icon.props.className).toContain('text-blue-500')
  })

  test('toast.warning calls sonnerToast.warning with amber AlertTriangle icon', () => {
    toast.warning('Careful')

    expect(mockWarning).toHaveBeenCalledOnce()
    const [message, options] = mockWarning.mock.calls[0]
    expect(message).toBe('Careful')
    expect(options.duration).toBe(4000)
    expect(options.icon).toBeDefined()
    expect(options.icon.type).toBe('AlertTriangle')
    expect(options.icon.props.className).toContain('text-amber-500')
  })

  test('toast.error with retry passes action button', () => {
    const retryFn = vi.fn()
    toast.error('Failed', { retry: retryFn })

    expect(mockError).toHaveBeenCalledOnce()
    const [, options] = mockError.mock.calls[0]
    expect(options.action).toBeDefined()
    expect(options.action.label).toBe('Retry')
    expect(options.action.onClick).toBe(retryFn)
  })

  test('toast.success allows custom options to override defaults', () => {
    toast.success('Done', { duration: 10000 })

    const [, options] = mockSuccess.mock.calls[0]
    // User-provided duration should override the default
    expect(options.duration).toBe(10000)
  })

  test('toast.error without retry does not include action', () => {
    toast.error('Failed')

    const [, options] = mockError.mock.calls[0]
    expect(options.action).toBeUndefined()
  })

  test('all icon elements have h-4 w-4 size classes', () => {
    toast.success('s')
    toast.error('e')
    toast.info('i')
    toast.warning('w')

    const successIcon = mockSuccess.mock.calls[0][1].icon
    const errorIcon = mockError.mock.calls[0][1].icon
    const infoIcon = mockInfo.mock.calls[0][1].icon
    const warningIcon = mockWarning.mock.calls[0][1].icon

    for (const icon of [successIcon, errorIcon, infoIcon, warningIcon]) {
      expect(icon.props.className).toContain('h-4')
      expect(icon.props.className).toContain('w-4')
    }
  })
})
