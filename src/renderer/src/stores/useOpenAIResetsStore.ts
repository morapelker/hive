import { create } from 'zustand'
import { usageApi } from '@/api/usage-api'
import { useUsageStore } from './useUsageStore'
import type { OpenAIResetCredit, OpenAIResetCredits } from '@shared/types/usage'

interface Selection {
  accountId: string
  email: string
  credit?: OpenAIResetCredit
  requestId: string
}
interface ResetState {
  accounts: Record<string, { data?: OpenAIResetCredits; loading?: boolean; error?: string }>
  selection: Selection | null
  pending: boolean
  message: string | null
  error: string | null
  load: (accountId: string, afterPending?: boolean) => Promise<void>
  select: (accountId: string, email: string, credit?: OpenAIResetCredit) => void
  close: () => void
  consume: () => Promise<void>
}
// Keep uncertain redemption IDs across popover/dialog closures. Retrying the same
// credit must not spend a second reset if the original response was lost.
const redemptionIds = new Map<string, string>()
const loads = new Map<string, Promise<void>>()
const selectionKey = (accountId: string, credit?: OpenAIResetCredit): string =>
  `${accountId}:${credit?.id ?? 'next'}`

export const useOpenAIResetsStore = create<ResetState>((set, get) => ({
  accounts: {},
  selection: null,
  pending: false,
  message: null,
  error: null,
  load: async (accountId, afterPending = false) => {
    const existing = loads.get(accountId)
    if (existing) {
      await existing
      if (!afterPending) return
    }
    const update = (value: ResetState['accounts'][string]): void =>
      set((s) => ({ accounts: { ...s.accounts, [accountId]: value } }))
    update({ ...get().accounts[accountId], loading: true, error: undefined })
    const request = (async () => {
      try {
        update({ data: await usageApi.listOpenaiResets(accountId), loading: false })
      } catch {
        update({
          ...get().accounts[accountId],
          loading: false,
          error: 'Could not refresh available resets.'
        })
      }
    })()
    loads.set(accountId, request)
    try {
      await request
    } finally {
      if (loads.get(accountId) === request) loads.delete(accountId)
    }
  },
  select: (accountId, email, credit) => {
    if (get().pending) return
    const key = selectionKey(accountId, credit)
    const requestId = redemptionIds.get(key) ?? crypto.randomUUID()
    redemptionIds.set(key, requestId)
    set({ selection: { accountId, email, credit, requestId }, error: null, message: null })
  },
  close: () => {
    if (!get().pending) set({ selection: null, message: null, error: null })
  },
  consume: async () => {
    const selection = get().selection
    if (!selection || get().pending || get().message) return
    set({ pending: true, error: null })
    try {
      const result = await usageApi.consumeOpenaiReset(
        selection.accountId,
        selection.requestId,
        selection.credit?.id
      )
      redemptionIds.delete(selectionKey(selection.accountId, selection.credit))
      const message =
        result.code === 'reset' || result.code === 'already_redeemed'
          ? 'Usage reset successfully. Usage meters may take a little while to update.'
          : result.code === 'nothing_to_reset'
            ? 'Your usage does not need a reset right now.'
            : 'That reset is no longer available.'
      set({ message })
      // A failed or delayed refresh cannot turn a confirmed redemption into a failure.
      await Promise.allSettled([
        get().load(selection.accountId, true),
        useUsageStore.getState().refreshSavedAccount(selection.accountId, { userInitiated: true })
      ])
      if (result.code === 'reset' || result.code === 'already_redeemed') {
        setTimeout(() => {
          void get().load(selection.accountId)
          void useUsageStore
            .getState()
            .refreshSavedAccount(selection.accountId, { userInitiated: true })
            .catch(() => {})
        }, 5000)
      }
    } catch {
      set({ error: 'Could not confirm the reset. Try again to safely check the same request.' })
    } finally {
      set({ pending: false })
    }
  }
}))
