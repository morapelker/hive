import { useMemo } from 'react'
import { usePRCommentStore } from '@/stores/usePRCommentStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { buildPRCommentPrompt } from '@/lib/pr-comment-prompt'

interface PRCommentsActionBarProps {
  worktreeId: string
}

export function PRCommentsActionBar({
  worktreeId
}: PRCommentsActionBarProps): React.JSX.Element | null {
  const selectedThreadIds = usePRCommentStore((s) => s.selectedThreadIds)
  const visibleThreads = usePRCommentStore((s) => s.getVisibleThreads(worktreeId))
  const selectAllVisible = usePRCommentStore((s) => s.selectAllVisible)
  const deselectAll = usePRCommentStore((s) => s.deselectAll)

  const selectedCount = selectedThreadIds.size
  const allVisibleSelected = useMemo(
    () =>
      visibleThreads.length > 0 &&
      visibleThreads.every((t) => selectedThreadIds.has(t.rootComment.id)),
    [visibleThreads, selectedThreadIds]
  )

  if (selectedCount === 0) return null

  const handleToggleAll = (): void => {
    if (allVisibleSelected) {
      deselectAll()
    } else {
      selectAllVisible(worktreeId)
    }
  }

  const handleDiscuss = (): void => {
    // Get selected threads
    const store = usePRCommentStore.getState()
    const visible = store.getVisibleThreads(worktreeId)
    const selected = visible.filter((t) =>
      store.selectedThreadIds.has(t.rootComment.id)
    )
    if (selected.length === 0) return

    // Get worktree data for branch name and path
    const worktreeState = useWorktreeStore.getState()
    let worktreePath = ''
    let branchName = ''
    for (const wts of worktreeState.worktreesByProject.values()) {
      const found = wts.find((w) => w.id === worktreeId)
      if (found) {
        worktreePath = found.path
        branchName = found.branch_name
        break
      }
    }
    if (!worktreePath) return

    // Get active session's opencode_session_id
    const sessionStore = useSessionStore.getState()
    const activeId = sessionStore.activeSessionId
    if (!activeId) return

    let opencodeSessionId: string | null = null
    for (const sessions of sessionStore.sessionsByWorktree.values()) {
      const session = sessions.find((s) => s.id === activeId)
      if (session) {
        opencodeSessionId = session.opencode_session_id
        break
      }
    }
    if (!opencodeSessionId) return

    // Build prompt and send
    const promptText = buildPRCommentPrompt(selected, branchName)
    if (!promptText) return

    window.opencodeOps.prompt(worktreePath, opencodeSessionId, promptText)

    // Deselect all threads
    store.deselectAll()

    // Switch to session view
    useFileViewerStore.getState().setActiveFile(null)
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-t border-border bg-muted/30">
      {/* Left: selection count */}
      <span className="text-xs font-medium text-muted-foreground">
        {selectedCount} thread{selectedCount === 1 ? '' : 's'} selected
      </span>

      {/* Center: select/deselect toggle */}
      <button
        onClick={handleToggleAll}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
      >
        {allVisibleSelected ? 'Deselect All' : 'Select All'}
      </button>

      {/* Right: discuss button */}
      <button
        onClick={handleDiscuss}
        className="text-xs font-medium px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Discuss with Agent
      </button>
    </div>
  )
}
