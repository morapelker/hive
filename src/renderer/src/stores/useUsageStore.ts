import { create } from 'zustand'
import type { UsageData } from '@shared/types/usage'

export type { UsageData }

interface UsageState {
  usage: UsageData | null
  lastFetchedAt: number | null
  isLoading: boolean
  fetchUsage: () => Promise<void>
}

const DEBOUNCE_MS = 180_000 // 3 minutes

export const useUsageStore = create<UsageState>()((set, get) => ({
  usage: null,
  lastFetchedAt: null,
  isLoading: false,

  fetchUsage: async () => {
    const { isLoading, lastFetchedAt } = get()
    if (isLoading) return
    if (lastFetchedAt && Date.now() - lastFetchedAt < DEBOUNCE_MS) return

    set({ isLoading: true })
    try {
      const result = await window.usageOps.fetch()
      if (result.success) {
        set({ usage: result.data })
      }
    } finally {
      set({ isLoading: false, lastFetchedAt: Date.now() })
    }
  }
}))
