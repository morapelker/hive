import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const MAX_HISTORY_SIZE = 100

interface PromptHistoryState {
  historyByScope: Record<string, string[]>
  // Actions
  addPrompt: (scopeId: string, prompt: string) => void
  getHistory: (scopeId: string) => string[]
}

export const usePromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set, get) => ({
      historyByScope: {},

      addPrompt: (scopeId: string, prompt: string) => {
        const trimmed = prompt.trim()
        if (!trimmed) return

        set((state) => {
          const existing = state.historyByScope[scopeId] ?? []
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
            historyByScope: {
              ...state.historyByScope,
              [scopeId]: capped
            }
          }
        })
      },

      getHistory: (scopeId: string) => {
        return get().historyByScope[scopeId] ?? []
      }
    }),
    {
      name: 'hive-prompt-history',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persisted: unknown, version: number) => {
        if (version === 0) {
          const old = persisted as { historyByWorktree?: Record<string, string[]> }
          return {
            historyByScope: old.historyByWorktree ?? {}
          }
        }
        return persisted as PromptHistoryState
      }
    }
  )
)
