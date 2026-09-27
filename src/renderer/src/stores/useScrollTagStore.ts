import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ScrollAnchor } from '@/lib/scroll-tag-anchors'

/**
 * Anchor for a scroll tag — the shared ScrollAnchor shape, structurally
 * identical to VirtualizedMessageListViewportAnchor so tags can be passed
 * straight to restoreViewportAnchor().
 */
export type ScrollTagAnchor = ScrollAnchor

export interface ScrollTag {
  id: string
  /** Hex color from SCROLL_TAG_COLORS, assigned at creation. */
  color: string
  anchor: ScrollTagAnchor
  /** 0..1 fraction of the conversation at creation time; render fallback when the anchor is unresolvable. */
  fractionHint: number
  createdAt: number
}

export const MAX_TAGS_PER_SESSION = 50
/** LRU cap on how many sessions keep tags in localStorage. */
export const MAX_SESSIONS = 50

interface ScrollTagState {
  tagsBySession: Record<string, ScrollTag[]>
  addTag: (sessionId: string, tag: ScrollTag) => void
  removeTag: (sessionId: string, tagId: string) => void
  /** Mark a session as recently used so the LRU session cap doesn't evict it. No-op for unknown sessions. */
  touchSession: (sessionId: string) => void
}

export const useScrollTagStore = create<ScrollTagState>()(
  persist(
    (set) => ({
      tagsBySession: {},

      addTag: (sessionId, tag) =>
        set((state) => {
          const existing = state.tagsBySession[sessionId] ?? []
          const next = [...existing, tag]
          // Cap per session: drop oldest first.
          while (next.length > MAX_TAGS_PER_SESSION) next.shift()

          // Re-insert the session key so insertion order tracks recency (LRU).
          const tagsBySession = { ...state.tagsBySession }
          delete tagsBySession[sessionId]
          tagsBySession[sessionId] = next

          // Cap total sessions: drop least-recently-touched first.
          const keys = Object.keys(tagsBySession)
          for (let i = 0; keys.length - i > MAX_SESSIONS; i++) {
            delete tagsBySession[keys[i]]
          }
          return { tagsBySession }
        }),

      removeTag: (sessionId, tagId) =>
        set((state) => {
          const existing = state.tagsBySession[sessionId]
          if (!existing) return state
          const next = existing.filter((t) => t.id !== tagId)
          const tagsBySession = { ...state.tagsBySession }
          if (next.length === 0) {
            delete tagsBySession[sessionId]
          } else {
            tagsBySession[sessionId] = next
          }
          return { tagsBySession }
        }),

      touchSession: (sessionId) =>
        set((state) => {
          const existing = state.tagsBySession[sessionId]
          if (!existing) return state
          const keys = Object.keys(state.tagsBySession)
          if (keys[keys.length - 1] === sessionId) return state
          // Re-insert the key so insertion order marks it most-recent.
          const tagsBySession = { ...state.tagsBySession }
          delete tagsBySession[sessionId]
          tagsBySession[sessionId] = existing
          return { tagsBySession }
        })
    }),
    {
      name: 'hive-scroll-tags',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ tagsBySession: state.tagsBySession })
    }
  )
)
