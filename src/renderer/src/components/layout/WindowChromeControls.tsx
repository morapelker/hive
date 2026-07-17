import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isLinux } from '@/lib/platform'

export function WindowChromeControls(): React.JSX.Element | null {
  const windowControls =
    isLinux() && typeof window.desktopBridge?.windowMinimize === 'function'
      ? window.desktopBridge
      : null

  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!windowControls) return
    void windowControls.windowIsMaximized?.().then(setIsMaximized)
    return windowControls.onWindowMaximizedChanged(setIsMaximized)
  }, [windowControls])

  if (!windowControls) return null

  return (
    <div
      className="flex items-center -mr-4"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-none"
        onClick={() => void windowControls.windowMinimize?.()}
        title="Minimize"
        data-testid="window-minimize"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-none"
        onClick={() => void windowControls.windowMaximize?.()}
        title={isMaximized ? 'Restore' : 'Maximize'}
        data-testid="window-maximize"
      >
        {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-none hover:bg-red-600 hover:text-white"
        onClick={() => void windowControls.windowClose()}
        title="Close"
        data-testid="window-close"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
