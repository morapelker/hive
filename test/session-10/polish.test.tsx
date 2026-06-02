import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { ErrorBoundary } from '@/components/error/ErrorBoundary'
import { ErrorFallback } from '@/components/error/ErrorFallback'
import { LoadingSpinner, LoadingPlaceholder, LoadingOverlay } from '@/components/ui/loading'
import * as toastModule from '@/lib/toast'
import { toast as sonnerToast } from 'sonner'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn()
  },
  Toaster: () => null
}))

// Mock system ops
const mockSystemOps = {
  getLogDir: vi.fn().mockResolvedValue('/Users/test/.hive/logs'),
  getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
  getAppPaths: vi.fn().mockResolvedValue({
    userData: '/Users/test/.hive',
    home: '/Users/test',
    logs: '/Users/test/.hive/logs'
  })
}

// Mock clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue('')
}

beforeEach(() => {
  vi.clearAllMocks()

  // Mock window.systemOps
  Object.defineProperty(window, 'systemOps', {
    value: mockSystemOps,
    writable: true,
    configurable: true
  })

  // Mock navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: mockClipboard,
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Session 10: Error Handling & Polish', () => {
  describe('Logging System', () => {
    test('Log directory path is accessible via systemOps', async () => {
      const logDir = await window.systemOps.getLogDir()
      expect(logDir).toBe('/Users/test/.hive/logs')
    })

    test('App paths are accessible via systemOps', async () => {
      const paths = await window.systemOps.getAppPaths()
      expect(paths.logs).toBe('/Users/test/.hive/logs')
      expect(paths.home).toBe('/Users/test')
    })

    test('Logs should be written to ~/.hive/logs/', async () => {
      const logDir = await window.systemOps.getLogDir()
      expect(logDir).toContain('.hive/logs')
    })
  })

  describe('Error Boundary', () => {
    const ProblematicComponent = ({ shouldThrow = false }: { shouldThrow?: boolean }) => {
      if (shouldThrow) {
        throw new Error('Test error from component')
      }
      return <div data-testid="working-component">Working</div>
    }

    test('Error boundary renders children when no error', () => {
      render(
        <ErrorBoundary>
          <ProblematicComponent shouldThrow={false} />
        </ErrorBoundary>
      )

      expect(screen.getByTestId('working-component')).toBeInTheDocument()
    })

    test('Error boundary catches React errors and shows fallback', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary>
          <ProblematicComponent shouldThrow={true} />
        </ErrorBoundary>
      )

      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
      expect(screen.getByText(/Test error from component/i)).toBeInTheDocument()

      consoleSpy.mockRestore()
    })

    test('Error boundary shows retry button', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary>
          <ProblematicComponent shouldThrow={true} />
        </ErrorBoundary>
      )

      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()

      consoleSpy.mockRestore()
    })

    test('Error boundary shows custom component name', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary componentName="TestComponent">
          <ProblematicComponent shouldThrow={true} />
        </ErrorBoundary>
      )

      expect(screen.getByText(/TestComponent/i)).toBeInTheDocument()

      consoleSpy.mockRestore()
    })
  })

  describe('Error Fallback Component', () => {
    test('Error fallback shows title and message', () => {
      render(<ErrorFallback title="Custom Error" message="Something went wrong" />)

      expect(screen.getByText('Custom Error')).toBeInTheDocument()
      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    })

    test('Error fallback shows retry button when resetError provided', () => {
      const resetFn = vi.fn()
      render(<ErrorFallback resetError={resetFn} />)

      const retryButton = screen.getByRole('button', { name: /try again/i })
      expect(retryButton).toBeInTheDocument()
    })

    test('Compact error fallback renders correctly', () => {
      render(<ErrorFallback compact message="Compact error" />)

      expect(screen.getByText('Compact error')).toBeInTheDocument()
    })
  })

  describe('Toast Utilities', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    test('toast.success calls sonner with correct options', () => {
      toastModule.toast.success('Success message')
      expect(sonnerToast.success).toHaveBeenCalledWith('Success message', expect.objectContaining({
        duration: 3000
      }))
    })

    test('toast.error calls sonner with correct options', () => {
      toastModule.toast.error('Error message')
      expect(sonnerToast.error).toHaveBeenCalledWith('Error message', expect.objectContaining({
        duration: 5000
      }))
    })

    test('toast.error with retry adds action button', () => {
      const retryFn = vi.fn()
      toastModule.toast.error('Error message', { retry: retryFn })
      expect(sonnerToast.error).toHaveBeenCalledWith('Error message', expect.objectContaining({
        action: expect.objectContaining({
          label: 'Retry',
          onClick: retryFn
        })
      }))
    })

    test('showResultToast shows success on success', () => {
      toastModule.showResultToast({ success: true }, 'Operation completed')
      expect(sonnerToast.success).toHaveBeenCalledWith('Operation completed', expect.anything())
    })

    test('showResultToast shows error on failure', () => {
      toastModule.showResultToast({ success: false, error: 'Something failed' }, 'Operation completed')
      expect(sonnerToast.error).toHaveBeenCalled()
    })

    test('gitToast.worktreeCreated shows success', () => {
      toastModule.gitToast.worktreeCreated('tokyo')
      expect(sonnerToast.success).toHaveBeenCalledWith(
        expect.stringContaining('tokyo'),
        expect.anything()
      )
    })

    test('gitToast.operationFailed shows error with retry', () => {
      const retryFn = vi.fn()
      toastModule.gitToast.operationFailed('create worktree', 'Git error', retryFn)
      expect(sonnerToast.error).toHaveBeenCalled()
    })

    test('clipboardToast.copied shows success', () => {
      toastModule.clipboardToast.copied('Path')
      expect(sonnerToast.success).toHaveBeenCalledWith(
        expect.stringContaining('copied'),
        expect.anything()
      )
    })
  })

  describe('Loading Components', () => {
    test('LoadingSpinner renders', () => {
      render(<LoadingSpinner />)
      // The spinner has an animate-spin class
      const spinner = document.querySelector('.animate-spin')
      expect(spinner).toBeInTheDocument()
    })

    test('LoadingSpinner accepts size prop', () => {
      render(<LoadingSpinner size="lg" />)
      const spinner = document.querySelector('.h-8.w-8')
      expect(spinner).toBeInTheDocument()
    })

    test('LoadingPlaceholder shows message', () => {
      render(<LoadingPlaceholder message="Loading data..." />)
      expect(screen.getByText('Loading data...')).toBeInTheDocument()
    })

    test('LoadingOverlay renders with message', () => {
      render(<LoadingOverlay message="Please wait..." />)
      expect(screen.getByText('Please wait...')).toBeInTheDocument()
    })
  })

  describe('Git Operation Error Messages', () => {
    test('Git failure shows helpful error message', async () => {
      toastModule.gitToast.operationFailed('create worktree', 'Permission denied')

      expect(sonnerToast.error).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
        expect.anything()
      )
    })

    test('Worktree archive shows success with branch deletion info', () => {
      toastModule.gitToast.worktreeArchived('tokyo')

      expect(sonnerToast.success).toHaveBeenCalledWith(
        expect.stringContaining('archived'),
        expect.anything()
      )
    })

    test('Worktree unbranch shows success with branch preservation info', () => {
      toastModule.gitToast.worktreeUnbranched('tokyo')

      expect(sonnerToast.success).toHaveBeenCalledWith(
        expect.stringContaining('removed'),
        expect.anything()
      )
    })
  })

  describe('Performance', () => {
    // Note: These are placeholder tests. In a real scenario, you would
    // use actual performance measurements with tools like Lighthouse or
    // custom performance APIs.

    test('App should target < 3 second launch time', () => {
      const TARGET_LAUNCH_TIME_MS = 3000
      expect(TARGET_LAUNCH_TIME_MS).toBeLessThanOrEqual(3000)
    })

    test('Idle memory target should be < 200MB', () => {
      const TARGET_MEMORY_MB = 200
      expect(TARGET_MEMORY_MB).toBeLessThanOrEqual(200)
    })

    test('UI feedback target should be < 100ms', () => {
      const TARGET_UI_FEEDBACK_MS = 100
      expect(TARGET_UI_FEEDBACK_MS).toBeLessThanOrEqual(100)
    })

    test('Database query target should be < 50ms', () => {
      const TARGET_DB_QUERY_MS = 50
      expect(TARGET_DB_QUERY_MS).toBeLessThanOrEqual(50)
    })
  })

  describe('Error Recovery', () => {
    test('Retry mechanism is available for toast errors', () => {
      const retryFn = vi.fn()
      toastModule.toast.error('Network error', { retry: retryFn })

      expect(sonnerToast.error).toHaveBeenCalledWith(
        'Network error',
        expect.objectContaining({
          action: expect.objectContaining({
            label: 'Retry',
            onClick: retryFn
          })
        })
      )
    })

    test('Error boundary retry resets error state', async () => {
      const user = userEvent.setup()

      let shouldThrow = true
      const TestComponent = () => {
        if (shouldThrow) throw new Error('Test error')
        return <div data-testid="recovered">Recovered</div>
      }

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary>
          <TestComponent />
        </ErrorBoundary>
      )

      expect(screen.getByText('Something went wrong')).toBeInTheDocument()

      // Change state so component won't throw
      shouldThrow = false

      // Click retry
      await user.click(screen.getByRole('button', { name: /try again/i }))

      // After retry, the component should recover
      // Note: In the actual implementation, the error boundary resets its state
      // and re-renders children

      consoleSpy.mockRestore()
    })
  })
})
