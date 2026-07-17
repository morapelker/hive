/**
 * Tracks handoff pickers that are currently open so background claude-cli
 * status transitions (plan followup, terminal plan approval) don't tear down
 * the UI the user is actively interacting with — closing the ticket modal or
 * unmounting the plan card mid-selection strands the picker popover at the
 * viewport corner. Teardown is skipped while a picker for that session (or an
 * unscoped picker) is open; the handoff confirm path unregisters synchronously
 * before dispatching so its own teardown still runs.
 */
const openHandoffPickers = new Map<string, string | null>()

export function setHandoffPickerOpen(
  pickerId: string,
  sessionId: string | null,
  open: boolean
): void {
  if (open) {
    openHandoffPickers.set(pickerId, sessionId)
  } else {
    openHandoffPickers.delete(pickerId)
  }
}

/** True when a handoff picker scoped to this session — or an unscoped one — is open. */
export function isHandoffPickerOpenForSession(sessionId: string): boolean {
  for (const scope of openHandoffPickers.values()) {
    if (scope === null || scope === sessionId) return true
  }
  return false
}

export function resetHandoffPickerState(): void {
  openHandoffPickers.clear()
}
