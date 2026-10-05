import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'

/** How long a text field waits after the last keystroke before it is written to the run. */
export const DOCFLOW_TEXT_DEBOUNCE_MS = 400

type Flush = () => Promise<void>

interface PendingWrites {
  /** Returns the unregister function. */
  register: (flush: Flush) => () => void
  /** Write every edit that is still waiting for its debounce. Rejects when a write fails. */
  flushAll: () => Promise<void>
}

const PendingWritesContext = createContext<PendingWrites | null>(null)

export const PendingWritesProvider = PendingWritesContext.Provider

/** Collects the debounced fields below it so a launch can write them all before it starts. */
export function usePendingWrites(): PendingWrites {
  const flushes = useRef(new Set<Flush>())
  return useMemo(
    () => ({
      register: (flush) => {
        flushes.current.add(flush)
        return () => {
          flushes.current.delete(flush)
        }
      },
      flushAll: async () => {
        await Promise.all([...flushes.current].map((flush) => flush()))
      }
    }),
    []
  )
}

function reportSaveFailure(error: unknown): void {
  toast.error(`Could not save your edit: ${error instanceof Error ? error.message : String(error)}`)
}

export interface DebouncedTextField {
  value: string
  setValue: (next: string) => void
  onFocus: () => void
  onBlur: () => void
}

/**
 * A text field backed by a stored value: typing updates the field at once and writes the
 * store after a pause. Untouched, it follows the stored value; an edit that is still pending
 * is written when the field is left or unmounts, so tabbing away, collapsing a row or closing
 * the dialog loses nothing.
 *
 * The server normalizes what it stores (trims, collapses spaces), so the value echoed back
 * after a write can differ from what was typed. While the field has focus that echo is held
 * back — adopting it would eat a trailing space mid-sentence — and shown once the field is left.
 */
export function useDebouncedText(
  storedValue: string,
  commit: (value: string) => Promise<unknown>
): DebouncedTextField {
  const pendingWrites = useContext(PendingWritesContext)
  const [draft, setDraft] = useState(storedValue)
  const latest = useRef(storedValue)
  const stored = useRef(storedValue)
  const dirty = useRef(false)
  const focused = useRef(false)
  const commitsInFlight = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(commit)

  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    dirty.current = false
    commitsInFlight.current += 1
    try {
      await commitRef.current(latest.current)
    } catch (error) {
      // Still unsaved: the next flush or keystroke tries again instead of dropping the edit.
      dirty.current = true
      throw error
    } finally {
      commitsInFlight.current -= 1
      // Settled while the field is not in use: show what is stored. A write can leave the
      // stored value as it was (a blank title is not written; a trimmed echo can equal the
      // previous string), in which case the effect below never runs and the draft would stand.
      if (!focused.current && !dirty.current && commitsInFlight.current === 0) {
        latest.current = stored.current
        setDraft(stored.current)
      }
    }
  }, [])

  useEffect(() => {
    stored.current = storedValue
    if (dirty.current || focused.current) return
    latest.current = storedValue
    setDraft(storedValue)
  }, [storedValue])

  const onFocus = useCallback((): void => {
    focused.current = true
  }, [])

  const onBlur = useCallback((): void => {
    focused.current = false
    // Leaving the field writes the pending edit now; the stored value is adopted once that
    // write (or one already in flight) settles.
    if (dirty.current) {
      flush().catch(reportSaveFailure)
      return
    }
    if (commitsInFlight.current > 0) return
    latest.current = stored.current
    setDraft(stored.current)
  }, [flush])

  useEffect(() => {
    const unregister = pendingWrites?.register(flush)
    return () => {
      unregister?.()
      flush().catch(reportSaveFailure)
    }
  }, [pendingWrites, flush])

  const setValue = useCallback(
    (next: string): void => {
      latest.current = next
      dirty.current = true
      setDraft(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        flush().catch(reportSaveFailure)
      }, DOCFLOW_TEXT_DEBOUNCE_MS)
    },
    [flush]
  )

  return { value: draft, setValue, onFocus, onBlur }
}
