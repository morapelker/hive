import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BackgroundWorkIndicator } from './BackgroundWorkIndicator'
import { countBackgroundWork, useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

const setWork = (work: {
  runningShells: number
  runningMonitors: number
  runningSubagents: number
}): void => {
  useWorktreeStatusStore.setState({ backgroundWorkBySession: { 'session-1': work } })
}

describe('BackgroundWorkIndicator', () => {
  afterEach(() => {
    cleanup()
    useWorktreeStatusStore.setState({ backgroundWorkBySession: {} })
  })

  // Wording matches the kanban card's badges for the same store entry.
  it('names a single running subagent', () => {
    setWork({ runningShells: 0, runningMonitors: 0, runningSubagents: 1 })

    render(<BackgroundWorkIndicator sessionId="session-1" />)

    expect(screen.getByTestId('background-work-indicator')).toHaveTextContent('1 subagent running')
  })

  it('lists each kind of background work that is running', () => {
    setWork({ runningShells: 1, runningMonitors: 1, runningSubagents: 3 })

    render(<BackgroundWorkIndicator sessionId="session-1" />)

    expect(screen.getByTestId('background-work-indicator')).toHaveTextContent(
      '3 subagents, 1 background shell, 1 monitor running'
    )
  })

  it('renders nothing once the session reports no background work', () => {
    // What the main process sends when the live set drains: all counts zero,
    // which drops the store entry and returns the composer to normal.
    setWork({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })

    render(<BackgroundWorkIndicator sessionId="session-1" />)

    expect(screen.queryByTestId('background-work-indicator')).toBeNull()
  })

  it('renders nothing for a session with no entry', () => {
    render(<BackgroundWorkIndicator sessionId="other-session" />)

    expect(screen.queryByTestId('background-work-indicator')).toBeNull()
  })
})

// This total is what keeps the composer's progress bar alive past the result.
describe('countBackgroundWork', () => {
  it('totals every kind of live background work', () => {
    expect(countBackgroundWork({ runningShells: 1, runningMonitors: 1, runningSubagents: 2 })).toBe(
      4
    )
  })

  it('is zero when the session has no background work', () => {
    expect(countBackgroundWork(undefined)).toBe(0)
    expect(countBackgroundWork({ runningShells: 0, runningMonitors: 0, runningSubagents: 0 })).toBe(
      0
    )
  })
})
