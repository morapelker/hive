import { create } from 'zustand'
import type { PRReviewComment } from '@shared/types/git'
import { translate } from '@/i18n/useI18n'
import { DEFAULT_LOCALE } from '@/i18n/messages'
import { useSettingsStore } from './useSettingsStore'

function t(key: string, params?: Record<string, string | number | boolean>): string {
  const locale = useSettingsStore.getState().locale ?? DEFAULT_LOCALE
  return translate(locale, key, params)
}

export const UNKNOWN_REVIEWER_KEY = 'ghost'
export const UNKNOWN_PATH_KEY = '__unknown_path__'

function getReviewerKey(comment: PRReviewComment): string {
  return comment.user?.login ?? UNKNOWN_REVIEWER_KEY
}

function getPathKey(comment: PRReviewComment): string {
  return comment.path ?? UNKNOWN_PATH_KEY
}

interface PRReviewStoreState {
  // Data - keyed by worktreeId
  comments: Map<string, PRReviewComment[]>
  baseBranch: Map<string, string>
  loading: Map<string, boolean>
  error: Map<string, string | null>

  // Selection (global — user works on one worktree at a time)
  selectedCommentIds: Set<number>
  hiddenReviewers: Set<string>

  // Attached comments for session input (persists across tab switches)
  attachedComments: PRReviewComment[]

  // Actions
  fetchComments: (worktreeId: string, projectPath: string, prNumber: number) => Promise<void>
  clearComments: (worktreeId: string) => void
  toggleComment: (commentId: number) => void
  selectAll: (worktreeId: string) => void
  deselectAll: () => void
  toggleReviewer: (username: string) => void
  attachSelectedToChat: (worktreeId: string) => void
  removeAttachment: (commentId: number) => void
  clearAttachments: () => void

  // Derived helpers
  getVisibleComments: (worktreeId: string) => PRReviewComment[]
  getGroupedByFile: (worktreeId: string) => Map<string, PRReviewComment[]>
  getThreads: (comments: PRReviewComment[]) => Map<number, PRReviewComment[]>
  getUniqueReviewers: (worktreeId: string) => Array<{ login: string; count: number }>
}

export const usePRReviewStore = create<PRReviewStoreState>((set, get) => ({
  comments: new Map(),
  baseBranch: new Map(),
  loading: new Map(),
  error: new Map(),
  selectedCommentIds: new Set(),
  hiddenReviewers: new Set(),
  attachedComments: [],

  fetchComments: async (worktreeId, projectPath, prNumber) => {
    set((s) => {
      const loading = new Map(s.loading)
      loading.set(worktreeId, true)
      const error = new Map(s.error)
      error.set(worktreeId, null)
      return { loading, error }
    })
    try {
      const result = await window.gitOps.getPRReviewComments(projectPath, prNumber)
      if (result.success && result.comments) {
        set((s) => {
          const comments = new Map(s.comments)
          comments.set(worktreeId, result.comments!)
          const baseBranch = new Map(s.baseBranch)
          if (result.baseBranch) baseBranch.set(worktreeId, result.baseBranch)
          const loading = new Map(s.loading)
          loading.set(worktreeId, false)
          return { comments, baseBranch, loading }
        })
      } else {
        set((s) => {
          const error = new Map(s.error)
          error.set(worktreeId, result.error ?? t('prReview.store.fetchError'))
          const loading = new Map(s.loading)
          loading.set(worktreeId, false)
          return { error, loading }
        })
      }
    } catch (err) {
      set((s) => {
        const error = new Map(s.error)
        error.set(worktreeId, err instanceof Error ? err.message : String(err))
        const loading = new Map(s.loading)
        loading.set(worktreeId, false)
        return { error, loading }
      })
    }
  },

  clearComments: (worktreeId) => {
    set((s) => {
      const comments = new Map(s.comments)
      comments.delete(worktreeId)
      const baseBranch = new Map(s.baseBranch)
      baseBranch.delete(worktreeId)
      const loading = new Map(s.loading)
      loading.delete(worktreeId)
      const error = new Map(s.error)
      error.delete(worktreeId)
      return { comments, baseBranch, loading, error }
    })
  },

  toggleComment: (commentId) => {
    set((s) => {
      const selected = new Set(s.selectedCommentIds)
      if (selected.has(commentId)) {
        selected.delete(commentId)
      } else {
        selected.add(commentId)
      }
      return { selectedCommentIds: selected }
    })
  },

  selectAll: (worktreeId) => {
    const comments = get().getVisibleComments(worktreeId)
    // Select only root comments (not replies)
    const rootIds = comments.filter((c) => c.inReplyToId === null).map((c) => c.id)
    set({ selectedCommentIds: new Set(rootIds) })
  },

  deselectAll: () => {
    set({ selectedCommentIds: new Set() })
  },

  toggleReviewer: (username) => {
    set((s) => {
      const hidden = new Set(s.hiddenReviewers)
      if (hidden.has(username)) {
        hidden.delete(username)
      } else {
        hidden.add(username)
      }
      return { hiddenReviewers: hidden }
    })
  },

  attachSelectedToChat: (worktreeId) => {
    const state = get()
    const allComments = state.comments.get(worktreeId) ?? []
    const selected = state.selectedCommentIds
    const existingIds = new Set(state.attachedComments.map((c) => c.id))

    // Gather selected root comments with their threads
    const threads = state.getThreads(allComments)
    const newAttachments: PRReviewComment[] = []

    for (const [threadId, threadComments] of threads) {
      if (selected.has(threadId) && !existingIds.has(threadId)) {
        newAttachments.push(...threadComments.filter((c) => !existingIds.has(c.id)))
      }
    }

    set({
      attachedComments: [...state.attachedComments, ...newAttachments],
      selectedCommentIds: new Set()
    })
  },

  removeAttachment: (commentId) => {
    set((s) => ({
      attachedComments: s.attachedComments.filter((c) => c.id !== commentId)
    }))
  },

  clearAttachments: () => {
    set({ attachedComments: [], selectedCommentIds: new Set() })
  },

  getVisibleComments: (worktreeId) => {
    const state = get()
    const allComments = state.comments.get(worktreeId) ?? []
    const hidden = state.hiddenReviewers
    if (hidden.size === 0) return allComments
    return allComments.filter((c) => !hidden.has(getReviewerKey(c)))
  },

  getGroupedByFile: (worktreeId) => {
    const visible = get().getVisibleComments(worktreeId)
    const grouped = new Map<string, PRReviewComment[]>()
    for (const c of visible) {
      const filePath = getPathKey(c)
      const existing = grouped.get(filePath) ?? []
      existing.push(c)
      grouped.set(filePath, existing)
    }
    // Sort comments within each file by line number
    for (const [path, fileComments] of grouped) {
      grouped.set(
        path,
        fileComments.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      )
    }
    return grouped
  },

  getThreads: (comments) => {
    const threads = new Map<number, PRReviewComment[]>()
    for (const c of comments) {
      const threadId = c.inReplyToId ?? c.id
      const thread = threads.get(threadId) || []
      thread.push(c)
      threads.set(threadId, thread)
    }
    // Sort each thread chronologically
    for (const [key, thread] of threads) {
      threads.set(
        key,
        thread.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      )
    }
    return threads
  },

  getUniqueReviewers: (worktreeId) => {
    const allComments = get().comments.get(worktreeId) ?? []
    const counts = new Map<string, number>()
    for (const c of allComments) {
      const login = getReviewerKey(c)
      counts.set(login, (counts.get(login) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count)
  }
}))

// Export types
export type { PRReviewComment, PRReviewStoreState }
