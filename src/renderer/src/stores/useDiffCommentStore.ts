import { create } from 'zustand'
import { useWorktreeStore } from './useWorktreeStore'
import { type ReanchorResult } from '@/lib/diff-comment-anchor'

// ---------------------------------------------------------------------------
// Local type aliases — DiffComment is global (preload/index.d.ts),
// but the create/update shapes are only inline on the API methods.
// ---------------------------------------------------------------------------

export interface DiffCommentCreate {
  worktree_id: string
  file_path: string
  line_start: number
  line_end?: number | null
  anchor_text?: string | null
  anchor_context_before?: string | null
  anchor_context_after?: string | null
  body: string
}

export interface DiffCommentUpdate {
  body?: string
  line_start?: number
  line_end?: number | null
  anchor_text?: string | null
  anchor_context_before?: string | null
  anchor_context_after?: string | null
  is_outdated?: boolean
}

// ---------------------------------------------------------------------------
// Module-level jump event bus — lives outside Zustand state.
// Components subscribe via onJump() and trigger via jumpTo().
// ---------------------------------------------------------------------------

type JumpCallback = (commentId: string) => void
const jumpSubscribers = new Set<JumpCallback>()

export function jumpTo(commentId: string): void {
  for (const cb of jumpSubscribers) cb(commentId)
}

export function onJump(callback: JumpCallback): () => void {
  jumpSubscribers.add(callback)
  return () => {
    jumpSubscribers.delete(callback)
  }
}

// ---------------------------------------------------------------------------
// Module-level helper — locates which worktree bucket a comment belongs to.
// ---------------------------------------------------------------------------

function findCommentWorktree(
  comments: Map<string, DiffComment[]>,
  commentId: string
): { worktreeId: string; comment: DiffComment } | null {
  for (const [worktreeId, bucket] of comments) {
    const comment = bucket.find((c) => c.id === commentId)
    if (comment) return { worktreeId, comment }
  }
  return null
}

// ---------------------------------------------------------------------------
// Visibility throttle constant
// ---------------------------------------------------------------------------

const VISIBILITY_THROTTLE_MS = 2000

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

interface DiffCommentStoreState {
  // Data — keyed by worktreeId
  comments: Map<string, DiffComment[]>
  loadingByWorktree: Map<string, boolean>
  errorByWorktree: Map<string, string | null>

  // Attachment tracking (survives tab switches, not page reloads)
  attachedCommentIds: Set<string>

  // Async CRUD
  fetch: (worktreeId: string) => Promise<void>
  create: (data: DiffCommentCreate) => Promise<DiffComment | null>
  update: (id: string, data: DiffCommentUpdate) => Promise<DiffComment | null>
  remove: (id: string) => Promise<boolean>
  clearAll: (worktreeId: string) => Promise<void>

  // Synchronous local-only reanchor (no DB write)
  updateLocalLines: (worktreeId: string, updates: ReanchorResult[]) => void

  // Attach flow
  attachAllToChat: (worktreeId: string) => void
  detach: (id: string) => void
  clearAttached: () => void

  // Derived helpers
  getCommentsForFile: (worktreeId: string, filePath: string) => DiffComment[]
  getGroupedByFile: (worktreeId: string) => Map<string, DiffComment[]>
  getAttachedComments: () => DiffComment[]

  // Tab-focus refresh subscription
  subscribeFocusRefresh: () => () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDiffCommentStore = create<DiffCommentStoreState>((set, get) => ({
  comments: new Map(),
  loadingByWorktree: new Map(),
  errorByWorktree: new Map(),
  attachedCommentIds: new Set(),

  // ---------------------------------------------------------------------------
  // Async CRUD
  // ---------------------------------------------------------------------------

  fetch: async (worktreeId) => {
    set((s) => {
      const loadingByWorktree = new Map(s.loadingByWorktree)
      loadingByWorktree.set(worktreeId, true)
      const errorByWorktree = new Map(s.errorByWorktree)
      errorByWorktree.set(worktreeId, null)
      return { loadingByWorktree, errorByWorktree }
    })
    try {
      const result = await window.db.diffComment.list(worktreeId)
      set((s) => {
        const comments = new Map(s.comments)
        comments.set(worktreeId, result)
        const loadingByWorktree = new Map(s.loadingByWorktree)
        loadingByWorktree.set(worktreeId, false)
        return { comments, loadingByWorktree }
      })
    } catch (err) {
      set((s) => {
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.set(
          worktreeId,
          err instanceof Error ? err.message : 'Failed to fetch diff comments'
        )
        const loadingByWorktree = new Map(s.loadingByWorktree)
        loadingByWorktree.set(worktreeId, false)
        return { errorByWorktree, loadingByWorktree }
      })
    }
  },

  create: async (data) => {
    try {
      const created = await window.db.diffComment.create(data)
      set((s) => {
        const comments = new Map(s.comments)
        const bucket = comments.get(data.worktree_id) ?? []
        comments.set(data.worktree_id, [...bucket, created])
        return { comments }
      })
      return created
    } catch (err) {
      set((s) => {
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.set(
          data.worktree_id,
          err instanceof Error ? err.message : 'Failed to create diff comment'
        )
        return { errorByWorktree }
      })
      return null
    }
  },

  update: async (id, data) => {
    const found = findCommentWorktree(get().comments, id)
    if (!found) return null

    try {
      const updated = await window.db.diffComment.update(id, data)
      if (!updated) return null

      set((s) => {
        const comments = new Map(s.comments)
        const bucket = comments.get(found.worktreeId) ?? []
        comments.set(
          found.worktreeId,
          bucket.map((c) => (c.id === id ? updated : c))
        )
        return { comments }
      })
      return updated
    } catch (err) {
      set((s) => {
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.set(
          found.worktreeId,
          err instanceof Error ? err.message : 'Failed to update diff comment'
        )
        return { errorByWorktree }
      })
      return null
    }
  },

  remove: async (id) => {
    const found = findCommentWorktree(get().comments, id)
    if (!found) return false

    try {
      const deleted = await window.db.diffComment.delete(id)
      if (!deleted) return false

      set((s) => {
        const comments = new Map(s.comments)
        const bucket = comments.get(found.worktreeId) ?? []
        comments.set(
          found.worktreeId,
          bucket.filter((c) => c.id !== id)
        )
        const attachedCommentIds = new Set(s.attachedCommentIds)
        attachedCommentIds.delete(id)
        return { comments, attachedCommentIds }
      })
      return true
    } catch (err) {
      set((s) => {
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.set(
          found.worktreeId,
          err instanceof Error ? err.message : 'Failed to remove diff comment'
        )
        return { errorByWorktree }
      })
      return false
    }
  },

  clearAll: async (worktreeId) => {
    // Snapshot IDs before clearing so we can strip them from attachedCommentIds
    const idsToStrip = (get().comments.get(worktreeId) ?? []).map((c) => c.id)

    try {
      await window.db.diffComment.clearAll(worktreeId)

      set((s) => {
        const comments = new Map(s.comments)
        comments.set(worktreeId, [])
        const loadingByWorktree = new Map(s.loadingByWorktree)
        loadingByWorktree.delete(worktreeId)
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.delete(worktreeId)

        const attachedCommentIds = new Set(s.attachedCommentIds)
        for (const id of idsToStrip) {
          attachedCommentIds.delete(id)
        }
        return { comments, loadingByWorktree, errorByWorktree, attachedCommentIds }
      })
    } catch (err) {
      set((s) => {
        const errorByWorktree = new Map(s.errorByWorktree)
        errorByWorktree.set(
          worktreeId,
          err instanceof Error ? err.message : 'Failed to clear diff comments'
        )
        return { errorByWorktree }
      })
    }
  },

  updateLocalLines: (worktreeId, updates) => {
    if (updates.length === 0) return

    const updateMap = new Map(updates.map((u) => [u.id, u]))

    set((s) => {
      const bucket = s.comments.get(worktreeId)
      if (!bucket) return s

      let changed = false
      const newBucket = bucket.map((c) => {
        const upd = updateMap.get(c.id)
        if (!upd) return c
        if (
          c.line_start === upd.line_start &&
          c.line_end === upd.line_end &&
          c.is_outdated === upd.is_outdated
        )
          return c
        changed = true
        return { ...c, line_start: upd.line_start, line_end: upd.line_end, is_outdated: upd.is_outdated }
      })

      if (!changed) return s // critical: prevents unnecessary re-renders
      const comments = new Map(s.comments)
      comments.set(worktreeId, newBucket)
      return { comments }
    })
  },

  // ---------------------------------------------------------------------------
  // Attach flow
  // ---------------------------------------------------------------------------

  attachAllToChat: (worktreeId) => {
    const bucket = get().comments.get(worktreeId) ?? []
    if (bucket.length === 0) return

    set((s) => {
      const attachedCommentIds = new Set(s.attachedCommentIds)
      for (const c of bucket) {
        if (!c.is_outdated) {
          attachedCommentIds.add(c.id)
        }
      }
      return { attachedCommentIds }
    })
  },

  detach: (id) => {
    set((s) => {
      const attachedCommentIds = new Set(s.attachedCommentIds)
      attachedCommentIds.delete(id)
      return { attachedCommentIds }
    })
  },

  clearAttached: () => {
    set({ attachedCommentIds: new Set() })
  },

  // ---------------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------------

  getCommentsForFile: (worktreeId, filePath) => {
    return (get().comments.get(worktreeId) ?? []).filter(
      (c) => c.file_path === filePath
    )
  },

  getGroupedByFile: (worktreeId) => {
    const allComments = get().comments.get(worktreeId) ?? []
    const grouped = new Map<string, DiffComment[]>()
    for (const c of allComments) {
      const existing = grouped.get(c.file_path) ?? []
      existing.push(c)
      grouped.set(c.file_path, existing)
    }
    // Sort comments within each file by line_start
    for (const [path, fileComments] of grouped) {
      grouped.set(
        path,
        fileComments.sort((a, b) => a.line_start - b.line_start)
      )
    }
    return grouped
  },

  getAttachedComments: () => {
    const { attachedCommentIds, comments } = get()
    if (attachedCommentIds.size === 0) return []

    const result: DiffComment[] = []
    for (const bucket of comments.values()) {
      for (const c of bucket) {
        if (attachedCommentIds.has(c.id)) {
          result.push(c)
        }
      }
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Tab-focus refresh
  // ---------------------------------------------------------------------------

  subscribeFocusRefresh: () => {
    let lastRefreshTime = 0

    const unsubscribe = window.systemOps.onWindowFocused(() => {
      const now = Date.now()
      if (now - lastRefreshTime < VISIBILITY_THROTTLE_MS) return
      lastRefreshTime = now

      const { selectedWorktreeId } = useWorktreeStore.getState()
      if (!selectedWorktreeId) return

      get().fetch(selectedWorktreeId)
    })

    return unsubscribe
  }
}))
