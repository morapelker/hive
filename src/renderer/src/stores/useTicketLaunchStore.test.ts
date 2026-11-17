import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginTicketLaunch,
  isTicketLaunching,
  settleTicketLaunch,
  useTicketLaunchStore
} from './useTicketLaunchStore'

const phaseOf = (ticketId: string): string | undefined =>
  useTicketLaunchStore.getState().phaseByTicket[ticketId]

describe('useTicketLaunchStore', () => {
  beforeEach(() => {
    for (const ticketId of Object.keys(useTicketLaunchStore.getState().phaseByTicket)) {
      settleTicketLaunch(ticketId)
    }
  })

  it('marks a ticket from begin to release, with the phase the launch reports', () => {
    const hold = beginTicketLaunch('t1', 'worktree')
    expect(isTicketLaunching('t1')).toBe(true)
    expect(phaseOf('t1')).toBe('worktree')

    hold.setPhase('session')
    expect(phaseOf('t1')).toBe('session')

    hold.release()
    expect(isTicketLaunching('t1')).toBe(false)
    expect(phaseOf('t1')).toBeUndefined()
  })

  it('keeps a ticket marked while any of its nested holds is live', () => {
    const batch = beginTicketLaunch('t1')
    const launch = beginTicketLaunch('t1', 'worktree')
    expect(phaseOf('t1')).toBe('worktree')

    // The inner launch failed: the batch still holds the ticket
    launch.release()
    launch.release()
    expect(isTicketLaunching('t1')).toBe(true)

    batch.release()
    expect(isTicketLaunching('t1')).toBe(false)
  })

  it('ends every hold once the launch settles, and ignores them afterwards', () => {
    const batch = beginTicketLaunch('t1')
    const launch = beginTicketLaunch('t1', 'session')

    settleTicketLaunch('t1')
    expect(isTicketLaunching('t1')).toBe(false)

    // A hold from before the settle neither marks the ticket again nor ends a later launch
    launch.setPhase('worktree')
    expect(isTicketLaunching('t1')).toBe(false)
    const relaunch = beginTicketLaunch('t1', 'worktree')
    batch.release()
    launch.release()
    expect(phaseOf('t1')).toBe('worktree')
    relaunch.release()
    expect(isTicketLaunching('t1')).toBe(false)
  })

  it('tracks tickets independently', () => {
    const first = beginTicketLaunch('t1')
    beginTicketLaunch('t2', 'session')
    first.release()
    expect(isTicketLaunching('t1')).toBe(false)
    expect(phaseOf('t2')).toBe('session')
  })
})
