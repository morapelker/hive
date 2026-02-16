import { useEffect, useRef } from 'react'
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-slim'
import type { Diff2HtmlUIConfig } from 'diff2html/lib-esm/ui/js/diff2html-ui-base'
import { cn } from '@/lib/utils'

export type DiffViewMode = 'unified' | 'split'

interface DiffViewerProps {
  diff: string
  viewMode?: DiffViewMode
  className?: string
}

export function DiffViewer({
  diff,
  viewMode = 'unified',
  className
}: DiffViewerProps): React.JSX.Element {
  const targetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!targetRef.current) return

    if (!diff) {
      targetRef.current.innerHTML = '<div class="d2h-empty">No changes</div>'
      return
    }

    const config: Diff2HtmlUIConfig = {
      drawFileList: false,
      matching: 'lines',
      outputFormat: viewMode === 'split' ? 'side-by-side' : 'line-by-line',
      renderNothingWhenEmpty: false,
      highlight: true,
      synchronisedScroll: true,
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false
    }

    try {
      const ui = new Diff2HtmlUI(targetRef.current, diff, config)
      ui.draw()
    } catch (error) {
      console.error('Failed to parse diff:', error)
      if (targetRef.current) {
        targetRef.current.innerHTML = '<div class="d2h-error">Failed to parse diff</div>'
      }
    }

    return () => {
      if (targetRef.current) {
        targetRef.current.innerHTML = ''
      }
    }
  }, [diff, viewMode])

  return (
    <div
      ref={targetRef}
      className={cn('diff-viewer', className)}
      data-testid="diff-viewer"
      role="region"
      aria-label="File diff viewer"
    />
  )
}
