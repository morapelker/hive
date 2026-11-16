/**
 * The "New ticket" action of the board on screen, for the New Ticket shortcut (Cmd+N).
 *
 * The board's To Do column registers its opener while it offers "New ticket" (not while a
 * search query filters the board, where a new ticket would vanish behind the filter). MainPane
 * mounts one board at a time, so there is at most one opener; with no board on screen there is
 * none and the shortcut leaves the key alone.
 */
let opener: (() => void) | null = null

/** Registers the on-screen board's opener. Returns the unregister function. */
export function registerBoardNewTicket(open: () => void): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/** Whether a board that can take a new ticket is on screen. */
export function canOpenBoardNewTicket(): boolean {
  return opener !== null
}

/** Opens the on-screen board's ticket creation modal. Does nothing without a board. */
export function openBoardNewTicket(): void {
  opener?.()
}
