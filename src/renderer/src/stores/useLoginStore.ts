import { create } from 'zustand'
import type { LoginState, LoginStatusDTO, UsageProvider } from '@shared/types/usage'
import { accountApi } from '@/api/account-api'
import { toast } from '@/lib/toast'
import { useUsageStore } from './useUsageStore'
import { useAccountStore } from './useAccountStore'

export type { LoginState }

export interface ActiveLogin {
  loginId: string
  provider: UsageProvider
  email: string | null
  state: LoginState
  error: string | null
}

interface LoginState_ {
  activeLogin: ActiveLogin | null
  startLogin: (provider: UsageProvider, email?: string) => Promise<void>
  cancelLogin: () => Promise<void>
}

const POLL_INTERVAL_MS = 1500
const MAX_CONSECUTIVE_FAILURES = 5
const NON_TERMINAL_STATES: LoginState[] = ['launching', 'waiting', 'exchanging']

// Module-level poll bookkeeping. Only one login can be active at a time (the
// server enforces this too), so a single handle/counter is sufficient.
let pollTimeoutHandle: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0

function stopPolling(): void {
  if (pollTimeoutHandle !== null) {
    clearTimeout(pollTimeoutHandle)
    pollTimeoutHandle = null
  }
  consecutiveFailures = 0
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useLoginStore = create<LoginState_>()((set, get) => ({
  activeLogin: null,

  startLogin: async (provider: UsageProvider, email?: string) => {
    try {
      const { loginId } = await accountApi.loginStart(provider, email)
      consecutiveFailures = 0
      set({
        activeLogin: {
          loginId,
          provider,
          email: email ?? null,
          state: 'launching',
          error: null
        }
      })
      schedulePoll(loginId, provider, get, set)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  },

  cancelLogin: async () => {
    const current = get().activeLogin
    if (!current) return

    stopPolling()
    set({ activeLogin: null })
    try {
      await accountApi.loginCancel(current.loginId)
    } catch {
      // best-effort — local state is already cleared
    }
    toast.info('Sign-in cancelled')
  }
}))

function applyStatus(
  status: LoginStatusDTO,
  provider: UsageProvider,
  set: (partial: Partial<LoginState_>) => void
): void {
  if (status.state === 'done') {
    stopPolling()
    toast.success(`Signed in as ${status.email ?? 'account'}`)
    useUsageStore
      .getState()
      .loadSavedAccounts(provider)
      .catch(() => {})
    useAccountStore.getState().fetchEmail(provider)
    set({ activeLogin: null })
    return
  }

  if (status.state === 'failed') {
    stopPolling()
    toast.error(status.error ?? 'Sign-in failed')
    set({ activeLogin: null })
    return
  }

  if (status.state === 'cancelled') {
    stopPolling()
    toast.info('Sign-in cancelled')
    set({ activeLogin: null })
    return
  }

  set({
    activeLogin: {
      loginId: status.loginId,
      provider,
      email: status.email,
      state: status.state,
      error: status.error
    }
  })
}

function schedulePoll(
  loginId: string,
  provider: UsageProvider,
  get: () => LoginState_,
  set: (partial: Partial<LoginState_>) => void
): void {
  pollTimeoutHandle = setTimeout(() => {
    // Bail if this login was cancelled/replaced while the timer was pending.
    const current = get().activeLogin
    if (!current || current.loginId !== loginId) return

    accountApi
      .loginStatus(loginId)
      .then((status) => {
        // The login may have been cancelled/replaced while this request was
        // in flight — re-check before applying its (now stale) result or
        // rescheduling another poll for a login that's no longer active.
        if (get().activeLogin?.loginId !== loginId) return

        consecutiveFailures = 0
        applyStatus(status, provider, set)
        if (NON_TERMINAL_STATES.includes(status.state)) {
          schedulePoll(loginId, provider, get, set)
        }
      })
      .catch(() => {
        if (get().activeLogin?.loginId !== loginId) return

        consecutiveFailures += 1
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopPolling()
          toast.error('Sign-in failed')
          set({ activeLogin: null })
          return
        }
        schedulePoll(loginId, provider, get, set)
      })
  }, POLL_INTERVAL_MS)
}
