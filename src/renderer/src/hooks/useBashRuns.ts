import { useState, useEffect, useCallback, useRef } from 'react'
import { Effect, Either } from 'effect'
import { toast } from '@/lib/toast'
import { runIpcEffect } from '@/lib/effect'
import type { Envelope } from '@shared/types/ipc-envelope'

export interface BashRunView {
  id: string
  command: string
  output: string
  status: 'running' | 'exited' | 'killed' | 'truncated' | 'error'
  startedAt: number
}

export function useBashRuns(sessionId: string): {
  runs: BashRunView[]
  isRunning: boolean
  runCommand: (command: string, cwd: string) => Promise<void>
  abort: () => Promise<void>
} {
  const [runs, setRuns] = useState<BashRunView[]>([])
  const runsRef = useRef(runs)
  runsRef.current = runs

  // Seed state from any existing run on mount
  useEffect(() => {
    let cancelled = false
    Effect.runPromise(
      Effect.either(
        runIpcEffect(
          () => window.bash.getRun(sessionId) as unknown as Promise<Envelope<BashRunSnapshot | null>>
        )
      )
    ).then((result) => {
      if (cancelled || Either.isLeft(result)) return

      const snapshot = result.right
      if (!snapshot) return

      // Avoid duplicates if a stream event already added this run
      setRuns((prev) => {
        if (prev.some((r) => r.id === snapshot.id)) return prev
        return [
          ...prev,
          {
            id: snapshot.id,
            command: snapshot.command,
            output: snapshot.outputBuffer,
            status: snapshot.status,
            startedAt: snapshot.startedAt
          }
        ]
      })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Subscribe to stream events
  useEffect(() => {
    const unsubscribe = window.bash.onStream((event: BashStreamEvent) => {
      if (event.sessionId !== sessionId) return

      if (event.type === 'start') {
        setRuns((prev) => {
          // Dedup in case seed already added it
          if (prev.some((r) => r.id === event.runId)) return prev
          return [
            ...prev,
            {
              id: event.runId,
              command: event.command,
              output: '',
              status: 'running',
              startedAt: event.startedAt
            }
          ]
        })
      } else if (event.type === 'output') {
        setRuns((prev) =>
          prev.map((r) => (r.id === event.runId ? { ...r, output: r.output + event.data } : r))
        )
      } else if (event.type === 'end') {
        setRuns((prev) =>
          prev.map((r) => (r.id === event.runId ? { ...r, status: event.status } : r))
        )
      }
    })

    return unsubscribe
  }, [sessionId])

  const isRunning = runs.some((r) => r.status === 'running')

  const runCommand = useCallback(
    async (command: string, cwd: string) => {
      const result = await Effect.runPromise(
        Effect.either(
          runIpcEffect(
            () =>
              window.bash.run(sessionId, command, cwd) as unknown as Promise<
                Envelope<{ runId?: string }>
              >
          )
        )
      )
      if (Either.isLeft(result)) {
        toast.error(result.left.error)
      }
    },
    [sessionId]
  )

  const abort = useCallback(async () => {
    await Effect.runPromise(
      Effect.either(
        runIpcEffect(() => window.bash.abort(sessionId) as unknown as Promise<Envelope<void>>)
      )
    )
  }, [sessionId])

  return { runs, isRunning, runCommand, abort }
}
