import { useCallback, useEffect, useRef, useState } from 'react'
import { documentFlowApi } from '@/api/document-flow-api'
import { toast } from '@/lib/toast'
import {
  clampMaxParallel,
  useDocumentFlowStore,
  type DocumentFlowPrefs
} from '@/stores/useDocumentFlowStore'
import type { DocumentRun, DocumentRunConfig } from '@shared/types/document-flow'
import { DOCFLOW_TEXT_DEBOUNCE_MS } from './useDebouncedText'

// Runs created in this app session whose settings still are the server's defaults. The
// remembered settings are applied when the run is first previewed, not at creation, so they
// never race the extraction that is writing the same row.
const runsAwaitingPrefs = new Set<string>()

export function markRunAwaitingPrefs(runId: string): void {
  runsAwaitingPrefs.add(runId)
}

function initialConfig(run: DocumentRun, prefs: DocumentFlowPrefs): DocumentRunConfig {
  let config = run.config
  if (runsAwaitingPrefs.has(run.id)) {
    config = {
      ...config,
      maxParallel: clampMaxParallel(prefs.maxParallel),
      interactive: prefs.interactive,
      promptStyle: prefs.promptStyle,
      defaultLaunch: prefs.defaultLaunch
    }
  }
  // null means "never chosen"; an empty string is the user's explicit "no verification".
  if (config.verifyCommand === null && run.project_id in prefs.verifyCommandByProject) {
    config = { ...config, verifyCommand: prefs.verifyCommandByProject[run.project_id] }
  }
  return config
}

export interface RunConfigDraft {
  config: DocumentRunConfig
  /** Change settings: written at once, or after a typing pause with `debounce`. */
  change: (patch: Partial<DocumentRunConfig>, options?: { debounce?: boolean }) => void
  /** Drop any scheduled write and return the settings to send with the launch. */
  settle: () => DocumentRunConfig
}

/**
 * The run settings being edited in the preview. Every write sends the whole config, so it
 * lands the same whether the server merges or replaces the stored object.
 */
export function useRunConfigDraft(run: DocumentRun): RunConfigDraft {
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  const [config, setConfig] = useState<DocumentRunConfig>(() =>
    initialConfig(run, useDocumentFlowStore.getState().prefs)
  )
  const latest = useRef(config)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seeded = useRef(false)
  const runId = run.id
  const projectId = run.project_id
  const storedConfig = run.config

  const write = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    updateRun(runId, { config: latest.current }).catch((error: unknown) => {
      toast.error(
        `Could not save the run settings: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }, [runId, updateRun])

  const change = useCallback(
    (patch: Partial<DocumentRunConfig>, options?: { debounce?: boolean }): void => {
      const next = { ...latest.current, ...patch }
      latest.current = next
      setConfig(next)
      if (timer.current) clearTimeout(timer.current)
      if (options?.debounce) {
        timer.current = setTimeout(write, DOCFLOW_TEXT_DEBOUNCE_MS)
      } else {
        write()
      }
    },
    [write]
  )

  const settle = useCallback((): DocumentRunConfig => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    return latest.current
  }, [])

  // Store the remembered settings the first time the run is previewed.
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    runsAwaitingPrefs.delete(runId)
    if (latest.current !== storedConfig) write()
  }, [runId, storedConfig, write])

  // No verify command chosen yet and none remembered for the project: offer a guess.
  useEffect(() => {
    if (latest.current.verifyCommand !== null) return
    let cancelled = false
    documentFlowApi
      .suggestVerifyCommand(projectId)
      .then((suggestion) => {
        if (cancelled || !suggestion || latest.current.verifyCommand !== null) return
        change({ verifyCommand: suggestion })
      })
      .catch(() => {
        // A missing suggestion only leaves the field empty.
      })
    return () => {
      cancelled = true
    }
  }, [projectId, change])

  // Closing the dialog mid-typing still writes the last edit.
  useEffect(
    () => () => {
      if (timer.current) write()
    },
    [write]
  )

  return { config, change, settle }
}
