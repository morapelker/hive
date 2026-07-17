import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { windowsCaptionPaddingRight } from '@/lib/desktop-chrome'
import { cn } from '@/lib/utils'
import { isMac, isWindows } from '@/lib/platform'

type DesktopWindowEscapeChromeProps = {
  /** Pre-ready strip: drag always, close when bridge exists. */
  boot?: boolean
  /** Error-boundary strip: muted bar when escape chrome is unavailable. */
  muted?: boolean
}

export function DesktopWindowEscapeChrome({
  boot = false,
  muted = false
}: DesktopWindowEscapeChromeProps): React.JSX.Element | null {
  const barClass = cn('h-12 border-b shrink-0 select-none', muted ? 'bg-muted' : 'bg-background')

  const dragStrip = (
    <div
      className={barClass}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="desktop-window-escape-chrome"
    />
  )

  if (isMac()) {
    if (boot) return dragStrip
    if (muted) return <div className="h-12 bg-muted" />
    return null
  }

  const bridge = window.desktopBridge
  if (typeof bridge?.windowClose !== 'function') {
    if (boot) return dragStrip
    if (muted) return <div className="h-12 bg-muted" />
    return null
  }

  return (
    <div
      className={cn(barClass, 'flex items-center justify-end')}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="desktop-window-escape-chrome"
    >
      <div
        className="flex items-center"
        style={
          {
            WebkitAppRegion: 'no-drag',
            ...(isWindows() ? { paddingRight: windowsCaptionPaddingRight } : {})
          } as React.CSSProperties
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12 rounded-none hover:bg-red-600 hover:text-white"
          onClick={() => void bridge.windowClose()}
          title="Close"
          data-testid="window-escape-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
