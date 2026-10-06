import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { clampMaxParallel, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { countOccupiedSlots } from '@shared/document-flow/planning'
import {
  DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
  type DocumentRun,
  type DocumentRunItem
} from '@shared/types/document-flow'

/** How long the stepper waits after the last click before the limit is written to the run. */
export const PARALLEL_WRITE_DEBOUNCE_MS = 300

const SLOT_HELP =
  'A ticket is in use while it is launching, working, being checked, resolving conflicts or waiting for your answer.'

interface RunParallelControlProps {
  run: DocumentRun
  items: readonly DocumentRunItem[]
  disabled?: boolean
}

/**
 * The parallel-tickets limit of a launched run, changeable while it runs. The limit only gates
 * launches: lowering it stops nothing, and raising it lets the orchestrator fill the new slots
 * on its next pass. A burst of clicks is one write of the value it ends on.
 */
export function RunParallelControl({
  run,
  items,
  disabled = false
}: RunParallelControlProps): React.JSX.Element {
  const runId = run.id
  // The value the user stepped to, shown until its write has settled; null = the run's own.
  const [draft, setDraft] = useState<number | null>(null)
  const draftRef = useRef<number | null>(null)
  // Counts the steps, so a write that settles can tell whether the draft is still its own.
  const steps = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const limit = draft ?? run.config.maxParallel
  const inUse = countOccupiedSlots(items)
  // A paused run launches nothing, whatever the limit.
  const launchRule =
    (run.status === 'paused' ? 'after you resume ' : '') +
    `new tickets start once fewer than ${limit} ${limit === 1 ? 'is' : 'are'} in use`

  const write = useCallback((): void => {
    timer.current = null
    const value = draftRef.current
    if (value === null) return
    const written = steps.current
    useDocumentFlowStore
      .getState()
      .setRunMaxParallel(runId, value)
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        toast.error(`Could not change the parallel tickets: ${message}`)
      })
      .finally(() => {
        // Stepped again meanwhile (even back to this value): that step has its own write coming.
        if (steps.current !== written) return
        draftRef.current = null
        setDraft(null)
      })
  }, [runId])

  // Closed (or switched to another run) inside the debounce: the last value is still written.
  useEffect(
    () => () => {
      if (timer.current === null) return
      clearTimeout(timer.current)
      write()
    },
    [write]
  )

  const step = (delta: number): void => {
    const next = clampMaxParallel((draftRef.current ?? run.config.maxParallel) + delta)
    draftRef.current = next
    steps.current += 1
    setDraft(next)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(write, PARALLEL_WRITE_DEBOUNCE_MS)
  }

  return (
    <div
      className="flex items-center gap-2 text-[12px] text-muted-foreground"
      data-testid="docflow-dashboard-parallel"
    >
      <span>Parallel tickets</span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="Fewer parallel tickets"
          data-testid="docflow-dashboard-parallel-decrease"
          disabled={disabled || limit <= 1}
          onClick={() => step(-1)}
        >
          <Minus />
        </Button>
        <span
          className="w-6 text-center tabular-nums text-foreground"
          data-testid="docflow-dashboard-parallel-value"
        >
          {limit}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="More parallel tickets"
          data-testid="docflow-dashboard-parallel-increase"
          disabled={disabled || limit >= DOCUMENT_RUN_MAX_PARALLEL_LIMIT}
          onClick={() => step(1)}
        >
          <Plus />
        </Button>
      </div>
      <span
        className="tabular-nums"
        title={SLOT_HELP}
        data-testid="docflow-dashboard-parallel-in-use"
      >
        {inUse} in use
        {inUse > limit && `: they keep going, and ${launchRule}`}
      </span>
    </div>
  )
}
