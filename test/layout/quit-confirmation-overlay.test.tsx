import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '@shared/shortcut-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'

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

    const request = vi.fn()
    const subscribe = vi.fn((channel: string, callback: (event: ServerEvent) => void) => {
      if (channel === QUIT_CONFIRMATION_SHOW_CHANNEL) {
        showHandler = () => {
          callback({
            channel,
            payload: undefined
          })
        }
        return unsubscribeShow
      }

      if (channel === QUIT_CONFIRMATION_HIDE_CHANNEL) {
        hideHandler = () => {
          callback({
            channel,
            payload: undefined
          })
        }
        return unsubscribeHide
      }

      return unsubscribeShow
    })

    setRendererRpcClient({ request, subscribe })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  it('shows on the renderer subscription and hides itself after two seconds', async () => {
    const { QuitConfirmationOverlay } = await import('@/components/layout/QuitConfirmationOverlay')

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

  it('hides immediately when the hide subscription event arrives', async () => {
    const { QuitConfirmationOverlay } = await import('@/components/layout/QuitConfirmationOverlay')

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

  it('unsubscribes from subscription events on unmount', async () => {
    const { QuitConfirmationOverlay } = await import('@/components/layout/QuitConfirmationOverlay')

    const { unmount } = render(<QuitConfirmationOverlay />)
    unmount()

    expect(unsubscribeShow).toHaveBeenCalled()
    expect(unsubscribeHide).toHaveBeenCalled()
  })
})
