import { toast as sonnerToast, ExternalToast } from 'sonner'

type ToastOptions = ExternalToast & {
  retry?: () => void | Promise<void>
}

/**
 * Enhanced toast notifications with consistent patterns
 */
export const toast = {
  /**
   * Show a success toast
   */
  success: (message: string, options?: ToastOptions): string | number => {
    return sonnerToast.success(message, {
      duration: 3000,
      ...options
    })
  },

  /**
   * Show an error toast with optional retry action
   */
  error: (message: string, options?: ToastOptions): string | number => {
    const { retry, ...rest } = options || {}

    return sonnerToast.error(message, {
      duration: 5000,
      ...rest,
      ...(retry && {
        action: {
          label: 'Retry',
          onClick: retry
        }
      })
    })
  },

  /**
   * Show a warning toast
   */
  warning: (message: string, options?: ToastOptions): string | number => {
    return sonnerToast.warning(message, {
      duration: 4000,
      ...options
    })
  },

  /**
   * Show an info toast
   */
  info: (message: string, options?: ToastOptions): string | number => {
    return sonnerToast.info(message, {
      duration: 3000,
      ...options
    })
  },

  /**
   * Show a loading toast (returns a function to update/dismiss it)
   */
  loading: (message: string, options?: ToastOptions): string | number => {
    return sonnerToast.loading(message, {
      duration: Infinity,
      ...options
    })
  },

  /**
   * Show a promise toast that handles loading/success/error states
   */
  promise: <T>(
    promise: Promise<T>,
    messages: {
      loading: string
      success: string | ((data: T) => string)
      error: string | ((error: unknown) => string)
    },
    options?: ToastOptions
  ): Promise<T> => {
    return sonnerToast.promise(promise, messages, options)
  },

  /**
   * Dismiss a specific toast or all toasts
   */
  dismiss: (toastId?: string | number): void => {
    sonnerToast.dismiss(toastId)
  },

  /**
   * Custom toast with full control
   */
  custom: (
    message: string,
    options?: ToastOptions & {
      icon?: React.ReactNode
    }
  ): string | number => {
    return sonnerToast(message, options)
  }
}

/**
 * Show an operation result toast
 * Automatically shows success or error based on result
 */
export function showResultToast(
  result: { success: boolean; error?: string },
  successMessage: string,
  options?: {
    retry?: () => void | Promise<void>
    errorPrefix?: string
  }
): void {
  if (result.success) {
    toast.success(successMessage)
  } else {
    const errorMessage = options?.errorPrefix
      ? `${options.errorPrefix}: ${result.error || 'Unknown error'}`
      : result.error || 'An error occurred'
    toast.error(errorMessage, { retry: options?.retry })
  }
}

/**
 * Toast for Git operations
 */
export const gitToast = {
  worktreeCreated: (name: string): string | number => {
    return toast.success(`Worktree "${name}" created successfully`)
  },

  worktreeArchived: (name: string): string | number => {
    return toast.success(`Worktree "${name}" archived and branch deleted`)
  },

  worktreeUnbranched: (name: string): string | number => {
    return toast.success(`Worktree "${name}" removed (branch preserved)`)
  },

  operationFailed: (operation: string, error?: string, retry?: () => void): string | number => {
    return toast.error(
      error ? `Failed to ${operation}: ${error}` : `Failed to ${operation}`,
      { retry }
    )
  }
}

/**
 * Toast for project operations
 */
export const projectToast = {
  added: (name: string): string | number => {
    return toast.success(`Project "${name}" added successfully`)
  },

  removed: (name: string): string | number => {
    return toast.success(`Project "${name}" removed from Hive`)
  },

  renamed: (name: string): string | number => {
    return toast.success(`Project renamed to "${name}"`)
  },

  validationError: (error: string): string | number => {
    return toast.error(error)
  }
}

/**
 * Toast for clipboard operations
 */
export const clipboardToast = {
  copied: (what: string = 'Content'): string | number => {
    return toast.success(`${what} copied to clipboard`)
  },

  failed: (): string | number => {
    return toast.error('Failed to copy to clipboard')
  }
}

/**
 * Toast for session operations
 */
export const sessionToast = {
  created: (): string | number => {
    return toast.success('New session created')
  },

  loaded: (name?: string): string | number => {
    return toast.success(name ? `Loaded session "${name}"` : 'Session loaded')
  },

  closed: (): string | number => {
    return toast.info('Session closed')
  },

  error: (error: string, retry?: () => void): string | number => {
    return toast.error(error, { retry })
  },

  archived: (): string | number => {
    return toast.info('This session is from an archived worktree. Opening in read-only mode.')
  }
}

export default toast
