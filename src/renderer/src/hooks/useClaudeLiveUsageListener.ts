import { useEffect } from 'react'
import type { ClaudeCodeModeUsageUnavailablePayload } from '@shared/types/claude-live-usage'
import { usageApi } from '@/api/usage-api'
import { toast } from '@/lib/toast'
import { useUsageStore } from '@/stores/useUsageStore'

/** One toast per window, whatever asks for it twice. */
export const CODE_MODE_USAGE_UNAVAILABLE_TOAST_ID = 'claude-code-mode-usage-unavailable'

export const CODE_MODE_USAGE_UNAVAILABLE_TITLE =
  'Live usage is unavailable in Code Mode with this version of Claude Code'

/** What the notice says under its title, in plain words (Code Mode T19; PRD FR-32). */
export const codeModeUsageUnavailableDescription = (cliVersion: string): string =>
  `Hive could not read live usage from Claude Code ${cliVersion}. Code Mode sessions keep working, with usage updated less often, until Claude Code or Hive is updated.`

/**
 * Live usage in Code Mode was switched off for the installed version of the Claude CLI: say
 * so, once. The cue reaches every window and can come again with a later session, so the
 * notice is claimed first, and only the window that gets it shows it. It stays until it is
 * closed: it is said one time only.
 */
async function tellCodeModeUsageUnavailable(): Promise<void> {
  let notice: ClaudeCodeModeUsageUnavailablePayload | null
  try {
    notice = await usageApi.claimClaudeCodeModeUsageUnavailableNotice()
  } catch {
    // Not claimed: the cue comes again with the next Code Mode session.
    return
  }
  if (!notice) return
  toast.warning(CODE_MODE_USAGE_UNAVAILABLE_TITLE, {
    id: CODE_MODE_USAGE_UNAVAILABLE_TOAST_ID,
    description: codeModeUsageUnavailableDescription(notice.cliVersion),
    duration: Infinity,
    closeButton: true
  })
}

/**
 * Feeds the local Claude API proxy's per-response usage events into the usage
 * store: the attributed saved-account row updates immediately, and the bottom
 * bar follows when that account is the active one. Also passes on when a
 * Code Mode session's debug log stops giving readings, so that the usage UI
 * does not go on saying "Live" for it, and tells the person, once, when live
 * usage in Code Mode has been switched off for their version of Claude Code.
 * Mount once at the app root.
 */
export function useClaudeLiveUsageListener(): void {
  useEffect(() => {
    const offUsage = usageApi.onClaudeLiveUsage((payload) => {
      useUsageStore.getState().applyClaudeLiveUsage(payload)
    })
    const offHealth = usageApi.onClaudeLiveUsageHealth((payload) => {
      useUsageStore.getState().applyClaudeLiveUsageHealth(payload)
    })
    const offUnavailable = usageApi.onClaudeCodeModeUsageUnavailable(() => {
      void tellCodeModeUsageUnavailable()
    })
    return () => {
      offUsage()
      offHealth()
      offUnavailable()
    }
  }, [])
}
