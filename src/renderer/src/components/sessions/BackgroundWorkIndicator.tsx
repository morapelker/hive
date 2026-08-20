import { useCallback } from 'react'

import { countBackgroundWork, useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * What is still running in the background for this session. Wording matches the
 * kanban card's background-work badges, since it is the same state.
 */
function label(work: { runningSubagents: number; runningShells: number; runningMonitors: number }) {
  const parts: string[] = []
  if (work.runningSubagents > 0) {
    parts.push(work.runningSubagents === 1 ? '1 subagent' : `${work.runningSubagents} subagents`)
  }
  if (work.runningShells > 0) {
    parts.push(
      work.runningShells === 1 ? '1 background shell' : `${work.runningShells} background shells`
    )
  }
  if (work.runningMonitors > 0) {
    parts.push(work.runningMonitors === 1 ? '1 monitor' : `${work.runningMonitors} monitors`)
  }
  return `${parts.join(', ')} running`
}

/**
 * Live background work of a session: subagents and shells that outlive the
 * turn's result. Their output goes to their own transcript, so without this the
 * composer looks finished while work is still going on.
 */
export function BackgroundWorkIndicator({
  sessionId
}: {
  sessionId: string | null | undefined
}): React.JSX.Element | null {
  const work = useWorktreeStatusStore(
    useCallback(
      (state) => (sessionId ? state.backgroundWorkBySession[sessionId] : undefined),
      [sessionId]
    )
  )

  if (countBackgroundWork(work) === 0 || !work) return null

  return (
    <span
      className="text-[10px] whitespace-nowrap text-muted-foreground/70"
      data-testid="background-work-indicator"
    >
      {label(work)}
    </span>
  )
}
