import { create } from 'zustand'
import type { PRReviewComment, PRReviewThread } from '@shared/types/pr-comment'

interface PRCommentStoreState {
  // Data - keyed by worktreeId
  commentsByWorktree: Map<string, PRReviewComment[]>
  baseBranchByWorktree: Map<string, string>
  isLoading: boolean
  lastFetchError: string | null
  lastFetchErrorCode: string | null // 'gh_not_found' | 'auth_failed' | etc.

  // Selection & filtering
  selectedThreadIds: Set<number> // root comment IDs
  disabledAuthors: Set<string> // author logins to hide

  // Actions
  fetchComments: (worktreeId: string, worktreePath: string, prNumber: number) => Promise<void>
  loadCachedComments: (worktreeId: string, prNumber: number) => Promise<void>
  clearComments: (worktreeId: string) => void
  toggleThreadSelection: (rootCommentId: number) => void
  selectAllVisible: (worktreeId: string) => void
  deselectAll: () => void
  toggleAuthorFilter: (login: string) => void
  resetAuthorFilter: () => void

  // Computed (use get() internally)
  getThreadsForWorktree: (worktreeId: string) => PRReviewThread[]
  getThreadsGroupedByFile: (worktreeId: string) => Map<string, PRReviewThread[]>
  getUniqueAuthors: (worktreeId: string) => { login: string; avatarUrl: string }[]
  getVisibleThreads: (worktreeId: string) => PRReviewThread[]
}

function buildThreads(comments: PRReviewComment[]): PRReviewThread[] {
  const roots: PRReviewComment[] = []
  const repliesByRootId = new Map<number, PRReviewComment[]>()

  for (const c of comments) {
    if (c.in_reply_to_id === null) {
      roots.push(c)
    } else {
      const existing = repliesByRootId.get(c.in_reply_to_id) || []
      existing.push(c)
      repliesByRootId.set(c.in_reply_to_id, existing)
    }
  }

  // Sort roots by created_at ascending
  roots.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  return roots.map((root) => {
    const replies = repliesByRootId.get(root.id) || []
    // Sort replies by created_at ascending
    replies.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    return { rootComment: root, replies }
  })
}

export const usePRCommentStore = create<PRCommentStoreState>((set, get) => ({
  commentsByWorktree: new Map(),
  baseBranchByWorktree: new Map(),
  isLoading: false,
  lastFetchError: null,
  lastFetchErrorCode: null,

  selectedThreadIds: new Set(),
  disabledAuthors: new Set(),

  fetchComments: async (worktreeId, worktreePath, prNumber) => {
    set({ isLoading: true, lastFetchError: null, lastFetchErrorCode: null })
    try {
      const result = await window.prCommentOps.fetch(worktreeId, worktreePath, prNumber)
      if (!result.success) {
        set({
          isLoading: false,
          lastFetchError: result.error || 'Failed to fetch comments',
          lastFetchErrorCode: result.errorCode || null
        })
        return
      }
      const newComments = new Map(get().commentsByWorktree)
      newComments.set(worktreeId, result.comments || [])
      const newBaseBranch = new Map(get().baseBranchByWorktree)
      if (result.baseBranch) {
        newBaseBranch.set(worktreeId, result.baseBranch)
      }
      set({
        commentsByWorktree: newComments,
        baseBranchByWorktree: newBaseBranch,
        isLoading: false,
        lastFetchError: null,
        lastFetchErrorCode: null
      })
    } catch (err) {
      set({
        isLoading: false,
        lastFetchError: err instanceof Error ? err.message : 'Failed to fetch comments',
        lastFetchErrorCode: null
      })
    }
  },

  loadCachedComments: async (worktreeId, prNumber) => {
    try {
      const result = await window.prCommentOps.get(worktreeId, prNumber)
      if (result.success && result.comments && result.comments.length > 0) {
        const newComments = new Map(get().commentsByWorktree)
        newComments.set(worktreeId, result.comments)
        set({ commentsByWorktree: newComments })
      }
    } catch {
      // Ignore cache load errors
    }
  },

  clearComments: (worktreeId) => {
    const newComments = new Map(get().commentsByWorktree)
    newComments.delete(worktreeId)
    const newBaseBranch = new Map(get().baseBranchByWorktree)
    newBaseBranch.delete(worktreeId)
    set({
      commentsByWorktree: newComments,
      baseBranchByWorktree: newBaseBranch
    })
  },

  toggleThreadSelection: (rootCommentId) => {
    const next = new Set(get().selectedThreadIds)
    if (next.has(rootCommentId)) {
      next.delete(rootCommentId)
    } else {
      next.add(rootCommentId)
    }
    set({ selectedThreadIds: next })
  },

  selectAllVisible: (worktreeId) => {
    const threads = get().getVisibleThreads(worktreeId)
    const next = new Set(get().selectedThreadIds)
    for (const t of threads) {
      next.add(t.rootComment.id)
    }
    set({ selectedThreadIds: next })
  },

  deselectAll: () => {
    set({ selectedThreadIds: new Set() })
  },

  toggleAuthorFilter: (login) => {
    const next = new Set(get().disabledAuthors)
    if (next.has(login)) {
      next.delete(login)
    } else {
      next.add(login)
    }
    set({ disabledAuthors: next })
  },

  resetAuthorFilter: () => {
    set({ disabledAuthors: new Set() })
  },

  getThreadsForWorktree: (worktreeId) => {
    const comments = get().commentsByWorktree.get(worktreeId) || []
    return buildThreads(comments)
  },

  getThreadsGroupedByFile: (worktreeId) => {
    const threads = get().getThreadsForWorktree(worktreeId)
    const grouped = new Map<string, PRReviewThread[]>()
    for (const t of threads) {
      const path = t.rootComment.path
      const existing = grouped.get(path) || []
      existing.push(t)
      grouped.set(path, existing)
    }
    return grouped
  },

  getUniqueAuthors: (worktreeId) => {
    const comments = get().commentsByWorktree.get(worktreeId) || []
    const seen = new Map<string, string>()
    for (const c of comments) {
      if (!seen.has(c.author_login)) {
        seen.set(c.author_login, c.author_avatar_url)
      }
    }
    return Array.from(seen.entries()).map(([login, avatarUrl]) => ({
      login,
      avatarUrl
    }))
  },

  getVisibleThreads: (worktreeId) => {
    const threads = get().getThreadsForWorktree(worktreeId)
    const { disabledAuthors } = get()
    if (disabledAuthors.size === 0) return threads
    return threads.filter((t) => !disabledAuthors.has(t.rootComment.author_login))
  }
}))
