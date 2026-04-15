import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, Terminal } from 'lucide-react'
import { ResizeHandle } from './ResizeHandle'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useTerminalPortal } from '@/contexts/TerminalPortalContext'
import { cn } from '@/lib/utils'

export function MainPaneTerminalPanel(): React.JSX.Element {
  const expanded = useLayoutStore((s) => s.bottomTerminalExpanded)
  const heightFraction = useLayoutStore((s) => s.bottomTerminalHeightFraction)
  const toggle = useLayoutStore((s) => s.toggleBottomTerminal)
  const setHeightFraction = useLayoutStore((s) => s.setBottomTerminalHeightFraction)
  const { registerTarget } = useTerminalPortal()

  const bottomTargetRef = useCallback(
    (el: HTMLDivElement | null) => registerTarget('bottom', el),
    [registerTarget]
  )

  const panelRef = useRef<HTMLDivElement>(null)
  const [parentHeight, setParentHeight] = useState(0)

  // Observe the parent (main pane) height for fraction-to-pixel conversion
  useEffect(() => {
    const parent = panelRef.current?.parentElement
    if (!parent) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setParentHeight(entry.contentRect.height)
      }
    })

    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const handleResize = useCallback(
    (delta: number) => {
      if (parentHeight <= 0) return
      const fractionDelta = delta / parentHeight
      const current = useLayoutStore.getState().bottomTerminalHeightFraction
      setHeightFraction(current + fractionDelta)
    },
    [parentHeight, setHeightFraction]
  )

  const computedHeight = expanded ? Math.round(parentHeight * heightFraction) : 0

  return (
    <div ref={panelRef} className="flex flex-col flex-shrink-0 border-t border-border">
      {/* Resize handle - only when expanded */}
      {expanded && <ResizeHandle direction="down" onResize={handleResize} />}

      {/* Toggle bar - always visible */}
      <button
        onClick={toggle}
        className={cn(
          'h-[30px] flex items-center gap-2 px-3 text-xs transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          expanded && 'border-b border-border'
        )}
        data-testid="bottom-terminal-toggle"
      >
        <Terminal className="h-3.5 w-3.5" />
        <span>Terminal</span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Terminal content - portal target */}
      <div
        ref={bottomTargetRef}
        style={{
          height: computedHeight,
          transition: 'height 150ms ease-in-out'
        }}
        className="overflow-hidden"
        data-testid="bottom-terminal-content"
      />
    </div>
  )
}
