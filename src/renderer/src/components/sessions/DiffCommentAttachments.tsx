import React from 'react'
import { MessageSquareText, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'

export function DiffCommentAttachments(): React.JSX.Element | null {
  const attachedComments = useDiffCommentStore(useShallow((s) => s.getAttachedComments()))
  const detach = useDiffCommentStore((s) => s.detach)

  if (attachedComments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachedComments.map((c) => {
        const fileName = c.file_path.split('/').pop() ?? c.file_path
        const lineLabel =
          c.line_end != null && c.line_end !== c.line_start
            ? `:${c.line_start}-${c.line_end}`
            : `:${c.line_start}`
        const bodyPreview = c.body.length > 80 ? c.body.slice(0, 80) + '...' : c.body

        return (
          <div
            key={c.id}
            className="group relative flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
          >
            <div className="flex items-center gap-2">
              <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium text-foreground truncate">{fileName}</span>
              <button
                onClick={() => detach(c.id)}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{lineLabel}</span>
              {c.is_outdated && (
                <span className="text-xs text-amber-500">outdated</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground line-clamp-2">{bodyPreview}</span>
          </div>
        )
      })}
    </div>
  )
}
