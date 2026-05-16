export const QUIT_CONFIRM_WINDOW_MS = 2000

let quitViaShortcut = false

/** Mark that the next quit was initiated by the Cmd+Q accelerator. */
export function markQuitViaShortcut(): void {
  quitViaShortcut = true
}

/** Read and reset the flag. Returns true only once per mark. */
export function consumeQuitViaShortcut(): boolean {
  const value = quitViaShortcut
  quitViaShortcut = false
  return value
}

export function readWarnBeforeQuitting(rawSettings: string | null): boolean {
  if (!rawSettings) return true

  try {
    const settings = JSON.parse(rawSettings) as { warnBeforeQuitting?: unknown }
    return settings.warnBeforeQuitting === false ? false : true
  } catch {
    return true
  }
}

export function getQuitConfirmationDecision({
  now,
  lastQuitConfirmAt,
  warnBeforeQuitting,
  confirmationWindowMs = QUIT_CONFIRM_WINDOW_MS
}: {
  now: number
  lastQuitConfirmAt: number | null
  warnBeforeQuitting: boolean
  confirmationWindowMs?: number
}): { shouldPreventQuit: boolean; lastQuitConfirmAt: number | null } {
  if (!warnBeforeQuitting) {
    return { shouldPreventQuit: false, lastQuitConfirmAt: null }
  }

  if (lastQuitConfirmAt && now - lastQuitConfirmAt < confirmationWindowMs) {
    return { shouldPreventQuit: false, lastQuitConfirmAt }
  }

  return { shouldPreventQuit: true, lastQuitConfirmAt: now }
}
