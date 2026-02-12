import { useMemo } from 'react'
import { html, Diff2HtmlConfig } from 'diff2html'
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
  const diffHtml = useMemo(() => {
    if (!diff) {
      return '<div class="d2h-empty">No changes</div>'
    }

    const config: Diff2HtmlConfig = {
      drawFileList: false,
      matching: 'lines',
      outputFormat: viewMode === 'split' ? 'side-by-side' : 'line-by-line',
      renderNothingWhenEmpty: false
    }

    try {
      return html(diff, config)
    } catch (error) {
      console.error('Failed to parse diff:', error)
      return '<div class="d2h-error">Failed to parse diff</div>'
    }
  }, [diff, viewMode])

  return (
    <div
      className={cn('diff-viewer overflow-auto', className)}
      data-testid="diff-viewer"
      role="region"
      aria-label="File diff viewer"
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  )
}
