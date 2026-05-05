import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, ChevronsUpDown, Minus, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HiddenAreasResult, Hunk } from '@/lib/diff-utils'
import type { editor } from 'monaco-editor'

export interface HunkHeaderActions {
  staged: boolean
  loadingHunkIndex: number | null
  onStage: (hunk: Hunk) => void
  onUnstage: (hunk: Hunk) => void
  onDiscard: (hunk: Hunk) => void
}

interface HunkViewDecorationsProps {
  modifiedEditor: editor.IStandaloneCodeEditor | null
  hunks: Hunk[]
  gaps: HiddenAreasResult['gaps']
  contextLines: number
  enabled: boolean
  onExpand: (gapIndex: number, direction: 'up' | 'down' | 'all') => void
  hunkActions?: HunkHeaderActions
}

type PortalTarget =
  | { type: 'header'; key: string; domNode: HTMLDivElement; hunk: Hunk }
  | {
      type: 'gap'
      key: string
      domNode: HTMLDivElement
      gap: HiddenAreasResult['gaps'][number]
      gapIndex: number
    }

export function HunkViewDecorations({
  modifiedEditor,
  hunks,
  gaps,
  contextLines,
  enabled,
  onExpand,
  hunkActions
}: HunkViewDecorationsProps): React.JSX.Element | null {
  const [portalTargets, setPortalTargets] = useState<PortalTarget[]>([])
  const zoneIdsRef = useRef<string[]>([])
  const hasHunkActions = Boolean(hunkActions)

  useEffect(() => {
    if (!modifiedEditor) return

    const removeExistingZones = (): void => {
      if (zoneIdsRef.current.length === 0) return
      modifiedEditor.changeViewZones((acc) => {
        for (const zoneId of zoneIdsRef.current) acc.removeZone(zoneId)
      })
      zoneIdsRef.current = []
    }

    removeExistingZones()

    if (!enabled) {
      setPortalTargets([])
      return
    }

    const nextTargets: PortalTarget[] = []
    const nextZoneIds: string[] = []

    modifiedEditor.changeViewZones((acc) => {
      for (const hunk of hunks) {
        const domNode = createZoneNode()
        const firstVisibleLine = getVisibleHunkAnchor(hunk, contextLines)
        const zoneId = acc.addZone({
          afterLineNumber: Math.max(0, firstVisibleLine - 1),
          heightInPx: hasHunkActions ? 34 : 22,
          domNode,
          showInHiddenAreas: true,
          suppressMouseDown: true
        })
        nextZoneIds.push(zoneId)
        nextTargets.push({
          type: 'header',
          key: `hunk-header-${hunk.index}`,
          domNode,
          hunk
        })
      }

      gaps.forEach((gap, gapIndex) => {
        const domNode = createZoneNode()
        const zoneId = acc.addZone({
          afterLineNumber: Math.max(0, gap.afterLine),
          heightInPx: 28,
          domNode,
          showInHiddenAreas: true,
          suppressMouseDown: true
        })
        nextZoneIds.push(zoneId)
        nextTargets.push({
          type: 'gap',
          key: `hunk-gap-${gap.firstHiddenModified}-${gap.lastHiddenModified}`,
          domNode,
          gap,
          gapIndex
        })
      })
    })

    zoneIdsRef.current = nextZoneIds
    setPortalTargets(nextTargets)

    return () => {
      modifiedEditor.changeViewZones((acc) => {
        for (const zoneId of nextZoneIds) acc.removeZone(zoneId)
      })
      zoneIdsRef.current = []
    }
  }, [modifiedEditor, hunks, gaps, contextLines, enabled, hasHunkActions])

  if (!modifiedEditor || !enabled) return null

  return (
    <>
      {portalTargets.map((target) =>
        createPortal(
          target.type === 'header' ? (
            <HunkHeader hunk={target.hunk} actions={hunkActions} />
          ) : (
            <GapControls
              gap={target.gap}
              onExpand={(direction) => onExpand(target.gapIndex, direction)}
            />
          ),
          target.domNode,
          target.key
        )
      )}
    </>
  )
}

function createZoneNode(): HTMLDivElement {
  const domNode = document.createElement('div')
  domNode.style.pointerEvents = 'auto'
  domNode.style.position = 'relative'
  domNode.style.zIndex = '1'
  return domNode
}

function getVisibleHunkAnchor(hunk: Hunk, contextLines: number): number {
  return Math.max(1, hunk.modifiedStartLine - contextLines)
}

function formatHunkHeader(hunk: Hunk): string {
  const originalCount =
    hunk.originalEndLine === 0 ? 0 : hunk.originalEndLine - hunk.originalStartLine + 1
  const modifiedCount =
    hunk.modifiedEndLine === 0 ? 0 : hunk.modifiedEndLine - hunk.modifiedStartLine + 1

  return `@@ -${hunk.originalStartLine},${originalCount} +${hunk.modifiedStartLine},${modifiedCount} @@`
}

function HunkHeader({
  hunk,
  actions
}: {
  hunk: Hunk
  actions?: HunkHeaderActions
}): React.JSX.Element {
  const stopMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
  }
  const isLoading = actions?.loadingHunkIndex === hunk.index

  return (
    <div
      className="h-full min-h-[22px] flex items-center justify-between gap-3 px-4 bg-muted/35 border-y border-border/50"
      onMouseDown={stopMouseDown}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="font-mono text-[11px] leading-none text-muted-foreground truncate">
        {formatHunkHeader(hunk)}
      </span>
      {actions && (
        <div className="flex items-center gap-1 shrink-0">
          {actions.staged ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-orange-400 hover:bg-orange-500/15 hover:text-orange-300"
              disabled={isLoading}
              title="Unstage hunk"
              onClick={() => actions.onUnstage(hunk)}
            >
              <Minus className="h-3 w-3" />
              Unstage hunk
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px] text-green-400 hover:bg-green-500/15 hover:text-green-300"
                disabled={isLoading}
                title="Stage hunk"
                onClick={() => actions.onStage(hunk)}
              >
                <Plus className="h-3 w-3" />
                Stage hunk
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px] text-red-400 hover:bg-red-500/15 hover:text-red-300"
                disabled={isLoading}
                title="Discard hunk"
                onClick={() => actions.onDiscard(hunk)}
              >
                <Trash2 className="h-3 w-3" />
                Discard hunk
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function GapControls({
  gap,
  onExpand
}: {
  gap: HiddenAreasResult['gaps'][number]
  onExpand: (direction: 'up' | 'down' | 'all') => void
}): React.JSX.Element {
  const handleMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
  }

  return (
    <div
      className="h-[28px] flex items-center justify-center gap-1 bg-muted/20 border-y border-border/40 text-[11px] text-muted-foreground"
      onMouseDown={handleMouseDown}
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        title="Show 10 hidden lines above"
        onClick={() => onExpand('up')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <span className="min-w-[92px] text-center tabular-nums">
        {gap.hiddenLineCount} hidden lines
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        title="Show 10 hidden lines below"
        onClick={() => onExpand('down')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        title="Show all hidden lines"
        onClick={() => onExpand('all')}
      >
        <ChevronsUpDown className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
