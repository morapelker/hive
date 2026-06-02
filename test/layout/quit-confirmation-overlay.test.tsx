import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('QuitConfirmationOverlay', () => {
  let showHandler: (() => void) | null
  let hideHandler: (() => void) | null
  let unsubscribeShow: ReturnType<typeof vi.fn>
  let unsubscribeHide: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    showHandler = null
    hideHandler = null
    unsubscribeShow = vi.fn()
    unsubscribeHide = vi.fn()

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        ...window.systemOps,
        onQuitConfirmationShow: vi.fn((callback: () => void) => {
          showHandler = callback
          return unsubscribeShow
        }),
        onQuitConfirmationHide: vi.fn((callback: () => void) => {
          hideHandler = callback
          return unsubscribeHide
        })
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows on IPC and hides itself after two seconds', async () => {
    const { QuitConfirmationOverlay } = await import(
      '@/components/layout/QuitConfirmationOverlay'
    )

    render(<QuitConfirmationOverlay />)
    expect(screen.queryByText(/again to Quit Hive/)).not.toBeInTheDocument()

    act(() => {
      showHandler?.()
    })

    expect(screen.getByText(/again to Quit Hive/)).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(screen.queryByText(/again to Quit Hive/)).not.toBeInTheDocument()
  })

  it('hides immediately when the hide IPC event arrives', async () => {
    const { QuitConfirmationOverlay } = await import(
      '@/components/layout/QuitConfirmationOverlay'
    )

    render(<QuitConfirmationOverlay />)

    act(() => {
      showHandler?.()
    })
    expect(screen.getByText(/again to Quit Hive/)).toBeInTheDocument()

    act(() => {
      hideHandler?.()
    })

    expect(screen.queryByText(/again to Quit Hive/)).not.toBeInTheDocument()
  })

  it('unsubscribes from IPC events on unmount', async () => {
    const { QuitConfirmationOverlay } = await import(
      '@/components/layout/QuitConfirmationOverlay'
    )

    const { unmount } = render(<QuitConfirmationOverlay />)
    unmount()

    expect(unsubscribeShow).toHaveBeenCalled()
    expect(unsubscribeHide).toHaveBeenCalled()
  })
})
