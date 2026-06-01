import { useEffect, useRef, useState } from 'react'
import { systemApi } from '@/api/system-api'

const QUIT_CONFIRMATION_DISPLAY_MS = 2000

export function QuitConfirmationOverlay(): React.JSX.Element | null {
  const [isVisible, setIsVisible] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearHideTimer = (): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }

    const hide = (): void => {
      clearHideTimer()
      setIsVisible(false)
    }

    const show = (): void => {
      clearHideTimer()
      setIsVisible(true)
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null
        setIsVisible(false)
      }, QUIT_CONFIRMATION_DISPLAY_MS)
    }

    const unsubscribeShow = systemApi.onQuitConfirmationShow(show)
    const unsubscribeHide = systemApi.onQuitConfirmationHide(hide)

    return () => {
      clearHideTimer()
      unsubscribeShow()
      unsubscribeHide()
    }
  }, [])

  if (!isVisible) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
      <div className="animate-in fade-in zoom-in-95 duration-150 rounded-xl border bg-background/95 px-6 py-4 text-center shadow-2xl backdrop-blur-md">
        <div className="text-base font-medium">
          Press <kbd className="mx-1 rounded bg-muted px-2 py-1 font-mono text-sm">⌘Q</kbd> again to
          Quit Hive
        </div>
      </div>
    </div>
  )
}
