import { create } from 'zustand'

/**
 * What a launch in flight is doing, for the line on the ticket's card: waiting for its turn
 * or getting ready, making the worktree (the slow part), or creating the session.
 */
export type TicketLaunchPhase = 'preparing' | 'worktree' | 'session'

interface TicketLaunchState {
  /**
   * Tickets a launch is working on and has not placed yet, by ticket id. Between the gesture
   * that starts a ticket and the session that puts it in In Progress nothing else on the
   * board changes (a worktree can take a while to make), so the card shows this instead, and
   * a second launch of the ticket is refused meanwhile.
   */
  phaseByTicket: Record<string, TicketLaunchPhase>
}

export const useTicketLaunchStore = create<TicketLaunchState>(() => ({ phaseByTicket: {} }))

/** One caller's claim that it is launching a ticket; see `beginTicketLaunch`. */
export interface TicketLaunchHold {
  /** Says what the launch is doing now. Ignored once the hold is released or the launch settled. */
  setPhase: (phase: TicketLaunchPhase) => void
  /** Ends this caller's claim; the ticket stops showing as launching once no caller holds it. Idempotent. */
  release: () => void
}

// The launch pipelines nest (a multi-model batch holds every ticket of the batch while each
// one's own launch holds it in turn), so a ticket is launching while at least one hold is live
const holdsByTicket = new Map<string, Set<symbol>>()

function setPhase(ticketId: string, phase: TicketLaunchPhase | null): void {
  useTicketLaunchStore.setState((state) => {
    if ((state.phaseByTicket[ticketId] ?? null) === phase) return state
    const next = { ...state.phaseByTicket }
    if (phase) next[ticketId] = phase
    else delete next[ticketId]
    return { phaseByTicket: next }
  })
}

/**
 * Mark a ticket as being launched, from now until the returned hold is released or the launch
 * settles (`settleTicketLaunch`). Synchronous, so a caller that marks before its first await
 * leaves no moment in which the same gesture could start the ticket twice.
 */
export function beginTicketLaunch(
  ticketId: string,
  phase: TicketLaunchPhase = 'preparing'
): TicketLaunchHold {
  const token = Symbol(ticketId)
  const holds = holdsByTicket.get(ticketId) ?? new Set<symbol>()
  holds.add(token)
  holdsByTicket.set(ticketId, holds)
  setPhase(ticketId, phase)

  const isLive = (): boolean => holdsByTicket.get(ticketId)?.has(token) === true
  return {
    setPhase: (next) => {
      if (isLive()) setPhase(ticketId, next)
    },
    release: () => {
      if (!isLive()) return
      holds.delete(token)
      if (holds.size > 0) return
      holdsByTicket.delete(ticketId)
      setPhase(ticketId, null)
    }
  }
}

/**
 * The launch placed the ticket (its session exists and the ticket is linked to it): from here
 * the card shows the session itself, so every hold on the ticket ends at once, whoever took it.
 */
export function settleTicketLaunch(ticketId: string): void {
  holdsByTicket.delete(ticketId)
  setPhase(ticketId, null)
}

export function isTicketLaunching(ticketId: string): boolean {
  return ticketId in useTicketLaunchStore.getState().phaseByTicket
}

/** What a refused second launch tells the user. */
export const TICKET_ALREADY_LAUNCHING = 'This ticket is already starting'

/** The line a launching ticket's card shows. */
export function ticketLaunchLabel(phase: TicketLaunchPhase): string {
  switch (phase) {
    case 'worktree':
      return 'Creating worktree…'
    case 'session':
      return 'Starting session…'
    default:
      return 'Starting…'
  }
}
