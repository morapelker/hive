// Run state of Shell tabs, kept outside the ShellTab component: only the active tab is mounted,
// and a statement must keep running (and keep its Cancel button) while the user looks at another
// tab, then show its result on return. Per tab: the in-flight query id, whether Cancel was
// pressed, the last finished run and the selected result tab. Memory only (results can be
// large); a tab's entry goes when the tab closes, which also cancels a statement still running.
// Also `databaseAfterRun`: the database a finished run leaves its tab in.

import { create } from 'zustand'
import type { DataStatementResult } from '@shared/data-projects/types'
import { isMongoShellParseError, parseMongoShellStructure } from '@shared/data-projects/mongo-shell'
import { dataProjectsApi } from '@/api/data-projects-api'
import { registerMongoCache } from './tab-caches'

export interface ShellRun {
  status: 'ok' | 'cancelled' | 'error' | 'declined' | 'blocked'
  statements: DataStatementResult[]
  /** Where the run text started in the document (error underline). */
  from: number
  durationMs?: number
  message?: string
}

export interface ShellRunEntry {
  /** The last finished run. */
  run: ShellRun | null
  /** Query id of the statement in flight. */
  running: string | null
  /** Cancel was pressed for `running` (its failure is then reported as "Cancelled"). */
  cancelRequested: boolean
  /** Result tab shown: a statement index or the Messages tab. */
  active: number | 'messages'
}

export const EMPTY_SHELL_RUN: Readonly<ShellRunEntry> = Object.freeze({
  run: null,
  running: null,
  cancelRequested: false,
  active: 0
})

interface ShellRunsState {
  entries: Record<string, ShellRunEntry>
}

export const useShellRuns = create<ShellRunsState>()(() => ({ entries: {} }))

export const shellRunEntry = (tabId: string): ShellRunEntry =>
  useShellRuns.getState().entries[tabId] ?? EMPTY_SHELL_RUN

const patch = (tabId: string, next: Partial<ShellRunEntry>): void =>
  useShellRuns.setState((state) => ({
    entries: {
      ...state.entries,
      [tabId]: { ...(state.entries[tabId] ?? EMPTY_SHELL_RUN), ...next }
    }
  }))

/** Marks `queryId` as the tab's statement in flight. */
export function startShellRun(tabId: string, queryId: string): void {
  patch(tabId, { running: queryId, cancelRequested: false })
}

/**
 * Stores the finished run of `queryId`. Ignored (false) when the tab closed meanwhile or another
 * run took its place, so a late answer cannot resurrect a closed tab's entry.
 */
export function finishShellRun(
  tabId: string,
  queryId: string,
  run: ShellRun,
  active: ShellRunEntry['active']
): boolean {
  const entry = useShellRuns.getState().entries[tabId]
  if (!entry || entry.running !== queryId) return false
  patch(tabId, { run, running: null, cancelRequested: false, active })
  return true
}

/** The result tab the user picked. */
export function setShellRunActive(tabId: string, active: ShellRunEntry['active']): void {
  if (shellRunEntry(tabId).active !== active) patch(tabId, { active })
}

/** Cancels the tab's statement in flight (no-op when nothing runs). */
export function cancelShellRun(tabId: string): void {
  const { running, cancelRequested } = shellRunEntry(tabId)
  if (!running) return
  if (!cancelRequested) patch(tabId, { cancelRequested: true })
  void dataProjectsApi.cancel(running).catch(() => undefined)
}

/**
 * The database a run leaves the tab in: the target of its last successful `use` (parsed, so
 * `use "shop"` is shop, not the quoted text), else the session database the server reports.
 */
export function databaseAfterRun(
  statements: readonly DataStatementResult[],
  reported: string | undefined
): string | undefined {
  for (let i = statements.length - 1; i >= 0; i--) {
    const st = statements[i]
    if (st.error) continue
    const structure = parseMongoShellStructure(st.text)
    if (!isMongoShellParseError(structure) && structure.method === 'use' && structure.database)
      return structure.database
  }
  return reported || undefined
}

/** Tests only. */
export function resetShellRuns(): void {
  useShellRuns.setState({ entries: {} })
}

registerMongoCache(({ tabIds }) => {
  const entries = useShellRuns.getState().entries
  const gone = tabIds.filter((id) => entries[id])
  if (!gone.length) return
  for (const id of gone) {
    const running = entries[id].running
    if (running) void dataProjectsApi.cancel(running).catch(() => undefined)
  }
  useShellRuns.setState((state) => {
    const next = { ...state.entries }
    for (const id of gone) delete next[id]
    return { entries: next }
  })
})
