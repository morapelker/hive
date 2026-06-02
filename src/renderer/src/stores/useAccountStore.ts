import { create } from 'zustand'
import type { UsageProvider } from '@shared/types/usage'
import { unwrapEnvelope } from '@/lib/ipc-envelope'

interface AccountState {
  anthropicEmail: string | null
  openaiEmail: string | null
  fetchEmail: (provider: UsageProvider) => Promise<void>
}

export const useAccountStore = create<AccountState>()((set) => ({
  anthropicEmail: null,
  openaiEmail: null,
  fetchEmail: async (provider: UsageProvider) => {
    try {
      if (provider === 'anthropic') {
        const email = unwrapEnvelope(await window.accountOps.getClaudeEmail())
        set({ anthropicEmail: email })
      } else {
        const email = unwrapEnvelope(await window.accountOps.getOpenAIEmail())
        set({ openaiEmail: email })
      }
    } catch {
      // Reset the slot to null on IPC failure so a revoked or missing credential
      // doesn't leave a stale email visible. The handler already returns null for
      // any read failure, so this catch mostly handles unexpected IPC errors.
      if (provider === 'anthropic') set({ anthropicEmail: null })
      else set({ openaiEmail: null })
    }
  }
}))
