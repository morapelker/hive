/**
 * Why a saved account stopped working, and when a working one will. Claude
 * sign-ins are not permanent: each one ends about 30 days after it was made
 * (refreshing its tokens does not extend it), so "expired" is routine and
 * predictable — while the other reasons below call for different handling.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** How far ahead an upcoming session end is called out. */
const SESSION_ENDING_SOON_MS = 7 * DAY_MS

export interface StaleAccountNotice {
  /** Short badge text. */
  label: string
  /** One-line explanation of what happened and what to do. */
  detail: string
}

/** Classify a `stale` account from the token-endpoint error stored as its `last_error`. */
export function staleAccountNotice(lastError: string | null): StaleAccountNotice {
  const error = lastError ?? ''
  if (error.includes('account_on_hold')) {
    return {
      label: 'On hold',
      detail: 'on hold at Anthropic - signing in again will not help until that is resolved'
    }
  }
  if (error.includes('Refresh token expired')) {
    return {
      label: 'Session expired',
      detail: 'sign-in expired (they last about 30 days) - sign in again'
    }
  }
  if (error.includes('Refresh token not found or invalid')) {
    return {
      label: 'Signed out',
      detail: 'sign-in was replaced or revoked elsewhere - sign in again'
    }
  }
  return { label: 'Expired', detail: 'expired - sign in again' }
}

/**
 * "Session ends in 3d" when a working account's sign-in ends within the next
 * week, so it can be renewed before it drops out; null otherwise (unknown,
 * comfortably far off, or already past — the next refresh reports that).
 */
export function sessionEndingSoonLabel(
  sessionExpiresAt: number | null | undefined,
  nowMs: number
): string | null {
  if (typeof sessionExpiresAt !== 'number') return null
  const remainingMs = sessionExpiresAt - nowMs
  if (remainingMs <= 0 || remainingMs > SESSION_ENDING_SOON_MS) return null
  if (remainingMs < DAY_MS) {
    return `Session ends in ${Math.max(1, Math.round(remainingMs / (60 * 60 * 1000)))}h`
  }
  return `Session ends in ${Math.floor(remainingMs / DAY_MS)}d`
}
