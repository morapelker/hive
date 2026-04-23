import { useState, useMemo, useCallback, useRef } from 'react'
import { MessageSquare, X, ChevronRight, ChevronDown } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format-utils'
import { useDiffCommentStore, jumpTo } from '@/stores/useDiffCommentStore'
import { useGitStore } from '@/stores/useGitStore'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_COMMENTS: DiffComment[] = []

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffCommentSidePanelProps {
  worktreeId: string
  worktreePath: string
  onClose: () => void
}

type SidePanelItem =
  | { type: 'section-header'; key: string; title: string; count: number; sectionKey: string }
  | { type: 'file-header'; key: string; filePath: string; fileName: string; count: number; fileKey: string }
  | { type: 'comment'; key: string; comment: DiffComment; sectionKey: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Group comments by file_path, sorting comments within each file by line_start. */
function groupByFile(comments: DiffComment[]): Map<string, DiffComment[]> {
  const grouped = new Map<string, DiffComment[]>()
  for (const c of comments) {
    const bucket = grouped.get(c.file_path)
    if (bucket) {
      bucket.push(c)
    } else {
      grouped.set(c.file_path, [c])
    }
  }
  for (const [path, fileComments] of grouped) {
    grouped.set(
      path,
      fileComments.sort((a, b) => a.line_start - b.line_start)
    )
  }
  return grouped
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DiffCommentSidePanel({
  worktreeId,
  worktreePath,
  onClose
}: DiffCommentSidePanelProps): React.JSX.Element {
  // ---------------------------------------------------------------------------
  // Store subscriptions — stable-reference pattern (see DiffCommentGutter)
  // ---------------------------------------------------------------------------

  const allComments = useDiffCommentStore(
    (s) => worktreeId ? s.comments.get(worktreeId) : undefined
  ) ?? EMPTY_COMMENTS

  const fileStatuses = useGitStore(
    (s) => worktreePath ? s.fileStatusesByWorktree.get(worktreePath) : undefined
  )

  // ---------------------------------------------------------------------------
  // Collapse state — 'outdated' starts collapsed
  // ---------------------------------------------------------------------------

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['outdated']))

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Categorize comments into Active / Outdated / Missing
  // ---------------------------------------------------------------------------

  const { activeByFile, outdatedByFile, missingByFile } = useMemo(() => {
    const diffFileSet = new Set(fileStatuses?.map((f) => f.relativePath))

    const active: DiffComment[] = []
    const outdated: DiffComment[] = []
    const missing: DiffComment[] = []

    for (const c of allComments) {
      if (c.is_outdated) {
        outdated.push(c)
      } else if (diffFileSet.has(c.file_path)) {
        active.push(c)
      } else {
        missing.push(c)
      }
    }

    return {
      activeByFile: groupByFile(active),
      outdatedByFile: groupByFile(outdated),
      missingByFile: groupByFile(missing)
    }
  }, [allComments, fileStatuses])

  // ---------------------------------------------------------------------------
  // Build flat item list for rendering
  // ---------------------------------------------------------------------------

  const flatItems = useMemo(() => {
    const items: SidePanelItem[] = []

    const pushSection = (
      sectionKey: string,
      title: string,
      byFile: Map<string, DiffComment[]>
    ): void => {
      if (byFile.size === 0) return

      let count = 0
      for (const comments of byFile.values()) count += comments.length

      items.push({
        type: 'section-header',
        key: `section-${sectionKey}`,
        title,
        count,
        sectionKey
      })

      if (collapsed.has(sectionKey)) return

      for (const [filePath, comments] of byFile) {
        const fileName = filePath.split('/').pop() ?? filePath
        const fileKey = filePath

        items.push({
          type: 'file-header',
          key: `file-${sectionKey}-${filePath}`,
          filePath,
          fileName,
          count: comments.length,
          fileKey
        })

        if (!collapsed.has(fileKey)) {
          for (const comment of comments) {
            items.push({
              type: 'comment',
              key: `comment-${comment.id}`,
              comment,
              sectionKey
            })
          }
        }
      }
    }

    pushSection('active', 'Active', activeByFile)
    pushSection('outdated', 'Outdated', outdatedByFile)
    pushSection('missing', 'Missing file', missingByFile)

    return items
  }, [activeByFile, outdatedByFile, missingByFile, collapsed])

  // ---------------------------------------------------------------------------
  // Conditional virtualization
  // ---------------------------------------------------------------------------

  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = flatItems.length > 50

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flatItems.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = flatItems[index]
      if (item.type === 'section-header') return 32
      if (item.type === 'file-header') return 28
      return 60
    },
    overscan: 10
  })

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderItem = (item: SidePanelItem): React.JSX.Element => {
    switch (item.type) {
      case 'section-header':
        return (
          <button
            type="button"
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50"
            onClick={() => toggleCollapsed(item.sectionKey)}
          >
            {collapsed.has(item.sectionKey) ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            <span>{item.title}</span>
            <span className="text-[10px] px-1 py-0.5 rounded bg-muted">
              {item.count}
            </span>
          </button>
        )

      case 'file-header':
        return (
          <button
            type="button"
            className="flex items-center gap-1.5 w-full px-4 py-1 text-xs text-muted-foreground hover:bg-accent/50"
            onClick={() => toggleCollapsed(item.fileKey)}
          >
            {collapsed.has(item.fileKey) ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{item.fileName}</span>
            <span className="text-[10px] px-1 py-0.5 rounded bg-muted shrink-0">
              {item.count}
            </span>
          </button>
        )

      case 'comment':
        return <CommentCard comment={item.comment} sectionKey={item.sectionKey} />
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="w-72 border-l border-border flex flex-col min-h-0 bg-background">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Comments</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title="Close side panel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Scrollable body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {allComments.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <MessageSquare className="h-8 w-8 mb-2" />
            <span className="text-xs">No comments yet</span>
          </div>
        ) : shouldVirtualize ? (
          /* Virtualized list */
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = flatItems[virtualRow.index]
              return (
                <div
                  key={item.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {renderItem(item)}
                </div>
              )
            })}
          </div>
        ) : (
          /* Plain list */
          flatItems.map((item) => (
            <div key={item.key}>{renderItem(item)}</div>
          ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CommentCard — individual comment item
// ---------------------------------------------------------------------------

function CommentCard({
  comment,
  sectionKey
}: {
  comment: DiffComment
  sectionKey: string
}): React.JSX.Element {
  const isSingleLine = comment.line_end === null
  const lineLabel = isSingleLine
    ? `L${comment.line_start}`
    : `L${comment.line_start}-${comment.line_end}`

  return (
    <button
      type="button"
      className={cn(
        'w-full text-left px-4 py-1.5 cursor-pointer hover:bg-accent/50 transition-colors',
        sectionKey === 'active' && 'border-l-2 border-violet-500/30',
        sectionKey === 'outdated' && 'border-l-2 border-yellow-500/40',
        sectionKey === 'missing' && 'opacity-60'
      )}
      onClick={() => jumpTo(comment.id)}
    >
      {/* Header line: line range + badges + timestamp */}
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">{lineLabel}</span>
        {sectionKey === 'outdated' && (
          <span className="px-1 py-px rounded text-[9px] font-medium bg-yellow-500/10 text-yellow-500">
            outdated
          </span>
        )}
        {sectionKey === 'missing' && (
          <span className="px-1 py-px rounded text-[9px] font-medium bg-muted text-muted-foreground">
            file not in diff
          </span>
        )}
        <span className="ml-auto text-muted-foreground shrink-0">
          {formatRelativeTime(new Date(comment.created_at).getTime())}
        </span>
      </div>

      {/* Body — truncated to 2 lines */}
      <p className="text-xs text-foreground line-clamp-2 break-words leading-relaxed mt-0.5">
        {comment.body}
      </p>

      {/* Outdated anchor snippet */}
      {sectionKey === 'outdated' && comment.anchor_text && (
        <div className="mt-1 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap max-h-16 overflow-hidden">
          {comment.anchor_text}
        </div>
      )}
    </button>
  )
}
