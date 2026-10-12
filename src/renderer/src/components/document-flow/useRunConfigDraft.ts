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

/**
 * Where the verify commands of a run live: one for the project (git), or one per member project
 * (connection project — `memberIds` in member order). The remembered commands and the
 * suggestions are keyed by the same ids.
 */
type VerifyTargets =
  { kind: 'project'; projectId: string } | { kind: 'members'; memberIds: string[] }

function verifyTargets(run: DocumentRun, memberIds: readonly string[] | null): VerifyTargets {
  return memberIds
    ? { kind: 'members', memberIds: [...memberIds] }
    : { kind: 'project', projectId: run.project_id }
}

/** The members whose verify command was never chosen (null means that; '' is an explicit none). */
function unchosenMembers(config: DocumentRunConfig, memberIds: readonly string[]): string[] {
  return memberIds.filter((id) => (config.memberVerifyCommands[id] ?? null) === null)
}

function initialConfig(
  run: DocumentRun,
  prefs: DocumentFlowPrefs,
  targets: VerifyTargets
): DocumentRunConfig {
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
  if (targets.kind === 'project') {
    if (config.verifyCommand === null && targets.projectId in prefs.verifyCommandByProject) {
      config = { ...config, verifyCommand: prefs.verifyCommandByProject[targets.projectId] }
    }
    return config
  }
  const remembered = unchosenMembers(config, targets.memberIds).filter(
    (id) => id in prefs.verifyCommandByProject
  )
  if (remembered.length === 0) return config
  const memberVerifyCommands = { ...config.memberVerifyCommands }
  for (const id of remembered) memberVerifyCommands[id] = prefs.verifyCommandByProject[id]
  return { ...config, memberVerifyCommands }
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
 * lands the same whether the server merges or replaces the stored object. `memberIds` are the
 * member projects of a connection project (null for a git project): their verify commands are
 * remembered and suggested per member.
 */
export function useRunConfigDraft(
  run: DocumentRun,
  memberIds: readonly string[] | null = null
): RunConfigDraft {
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  const [config, setConfig] = useState<DocumentRunConfig>(() =>
    initialConfig(run, useDocumentFlowStore.getState().prefs, verifyTargets(run, memberIds))
  )
  const latest = useRef(config)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seeded = useRef(false)
  const runId = run.id
  const projectId = run.project_id
  const storedConfig = run.config
  // Compared by content: the caller builds the list on every render.
  const memberIdsKey = memberIds ? memberIds.join(',') : null

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

  // No verify command chosen yet and none remembered for the project: offer a guess. On a
  // connection project the same per member, each guessed from that member's repository.
  useEffect(() => {
    let cancelled = false
    const suggest = (targetId: string, apply: (suggestion: string) => void): void => {
      documentFlowApi
        .suggestVerifyCommand(targetId)
        .then((suggestion) => {
          if (!cancelled && suggestion) apply(suggestion)
        })
        .catch(() => {
          // A missing suggestion only leaves the field empty.
        })
    }
    if (memberIdsKey === null) {
      if (latest.current.verifyCommand !== null) return
      suggest(projectId, (suggestion) => {
        if (latest.current.verifyCommand === null) change({ verifyCommand: suggestion })
      })
    } else {
      const memberIds = memberIdsKey ? memberIdsKey.split(',') : []
      for (const memberId of unchosenMembers(latest.current, memberIds)) {
        suggest(memberId, (suggestion) => {
          // Still unchosen: the user may have typed one while the guess was on its way.
          const current = latest.current.memberVerifyCommands
          if ((current[memberId] ?? null) !== null) return
          change({ memberVerifyCommands: { ...current, [memberId]: suggestion } })
        })
      }
    }
    return () => {
      cancelled = true
    }
  }, [projectId, memberIdsKey, change])

  // Closing the dialog mid-typing still writes the last edit.
  useEffect(
    () => () => {
      if (timer.current) write()
    },
    [write]
  )

  return { config, change, settle }
}
