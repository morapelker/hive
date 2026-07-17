import type { UsageProvider } from '@shared/types/usage'
import { isHiveTelemetryEnabled, reportHiveActiveAccounts } from '@/api/hive-enterprise/client'
import { useAccountStore } from '@/stores/useAccountStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * Reports the caller's active accounts to hive-enterprise so the org's
 * member↔account mapping (usage popover avatar stack) stays fresh, without
 * spamming the server on every trigger (launch, prompt send, account switch,
 * usage refresh — see the call sites). A full snapshot is sent immediately
 * whenever it differs from the last one successfully sent; otherwise at most
 * one heartbeat per hour keeps `last_seen_at` from going stale while nothing
 * has actually changed.
 */
const HEARTBEAT_MS = 60 * 60 * 1000 // 1 hour

const PROVIDERS: readonly UsageProvider[] = ['anthropic', 'openai']

let lastSentKey: string | null = null
let lastSentAt = 0
let inFlight = false

/** Reset module-level state between tests; not used by production code. */
export function resetHiveAccountReportStateForTests(): void {
  lastSentKey = null
  lastSentAt = 0
  inFlight = false
}

interface AccountSnapshotEntry {
  provider: UsageProvider
  email: string
}

/**
 * Re-read each provider's active-account email via `fetchEmail` (cheap local
 * IPC/file read) before building the snapshot — this doubles as detection for
 * an account switch that happened outside this app's own switch flow (e.g. a
 * `claude login` in a terminal). A provider whose email read fails is simply
 * omitted, never reported as logged-out: `fetchEmail` already resets its slot
 * to null on failure, and we must not overwrite a still-valid server row with
 * a transient local read error.
 */
async function resolveActiveAccountSnapshot(): Promise<AccountSnapshotEntry[]> {
  const entries: AccountSnapshotEntry[] = []
  for (const provider of PROVIDERS) {
    await useAccountStore.getState().fetchEmail(provider)
    const state = useAccountStore.getState()
    const email = provider === 'anthropic' ? state.anthropicEmail : state.openaiEmail
    if (email) entries.push({ provider, email: email.toLowerCase() })
  }
  return entries
}

export async function reportActiveAccountsSnapshot(): Promise<void> {
  if (!isHiveTelemetryEnabled(useSettingsStore.getState())) return
  if (inFlight) return

  inFlight = true
  try {
    const snapshot = await resolveActiveAccountSnapshot()
    if (snapshot.length === 0) return

    const key = JSON.stringify(snapshot)
    const now = Date.now()
    if (key === lastSentKey && now - lastSentAt < HEARTBEAT_MS) return

    const success = await reportHiveActiveAccounts(snapshot)
    if (success) {
      lastSentKey = key
      lastSentAt = now
    }
  } finally {
    inFlight = false
  }
}
