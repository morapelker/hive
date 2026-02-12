import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const MAX_HISTORY_SIZE = 100

interface PromptHistoryState {
  historyByWorktree: Record<string, string[]>
  // Actions
  addPrompt: (worktreeId: string, prompt: string) => void
  getHistory: (worktreeId: string) => string[]
}

export const usePromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set, get) => ({
      historyByWorktree: {},

      addPrompt: (worktreeId: string, prompt: string) => {
        const trimmed = prompt.trim()
        if (!trimmed) return

        set((state) => {
          const existing = state.historyByWorktree[worktreeId] ?? []
          // Deduplicate: remove existing match
          const filtered = existing.filter((p) => p !== trimmed)
          // Append newest at the end
          filtered.push(trimmed)
          // Cap at MAX_HISTORY_SIZE (FIFO eviction from the front)
          const capped =
            filtered.length > MAX_HISTORY_SIZE
              ? filtered.slice(filtered.length - MAX_HISTORY_SIZE)
              : filtered

          return {
            historyByWorktree: {
              ...state.historyByWorktree,
              [worktreeId]: capped
            }
          }
        })
      },

      getHistory: (worktreeId: string) => {
        return get().historyByWorktree[worktreeId] ?? []
      }
    }),
    {
      name: 'hive-prompt-history',
      storage: createJSONStorage(() => localStorage)
    }
  )
)
