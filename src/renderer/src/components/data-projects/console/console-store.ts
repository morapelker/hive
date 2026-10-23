// The console log as the renderer holds it: per data project, the server's entries (listed on
// open, then followed on DATA_CONSOLE_CHANNEL while a Console tab is mounted), plus the
// viewer's "Show metadata queries" choice (remembered in localStorage; best effort).
//
// A mounted Console tab also lists the new entries every CONSOLE_RENEW_MS: the server takes a
// list as "a console follows this project" for a while (console-log.ts: MongoDB command
// monitoring, which slows big reads, runs only then), and it catches up anything the live
// channel missed.
//
// Entries are merged by `seq` (an event can overtake the list that was in flight), capped like
// the server's rings (DATA_CONSOLE_MAX_ENTRIES statements + as many metadata entries), and
// dropped whole when the server's `epoch` changes (a restarted server numbers from 1 again).

import { create } from 'zustand'
import {
  DATA_CONSOLE_MAX_ENTRIES,
  type DataConsoleEntry,
  type DataConsoleEvent
} from '@shared/data-projects/console-types'
import { dataConsoleApi } from '@/api/data-console-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'

export interface ConsoleProjectLog {
  /** Oldest first, unique by seq. */
  entries: DataConsoleEntry[]
  epoch: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

interface DataConsoleState {
  logs: Record<string, ConsoleProjectLog>
  showMetadata: boolean
  setShowMetadata: (show: boolean) => void
  /** Lists the project's log from the server (merging what events already brought). */
  load: (projectId: string) => Promise<void>
  /** Lists only what is newer than the entries held (quietly: no loading state, no error). */
  sync: (projectId: string) => Promise<void>
  /** A live event from DATA_CONSOLE_CHANNEL. */
  apply: (event: DataConsoleEvent) => void
  /** Empties the project's log on the server (and here). */
  clear: (projectId: string) => Promise<void>
  forget: (projectId: string) => void
  reset: () => void
}

const SHOW_METADATA_KEY = 'hive:data-console:show-metadata'

/**
 * How often a mounted Console tab lists again: well within the server's watch lease
 * (CONSOLE_WATCH_LEASE_MS, 90 s, in main/services/data-projects/console-log.ts).
 */
export const CONSOLE_RENEW_MS = 30_000

const readShowMetadata = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(SHOW_METADATA_KEY) === '1'
  } catch {
    return false
  }
}

const EMPTY_LOG: ConsoleProjectLog = { entries: [], epoch: null, status: 'idle', error: null }

/** Merges two seq-ordered lists (duplicates dropped) and caps each kind like the server. */
export function mergeConsoleEntries(
  current: readonly DataConsoleEntry[],
  incoming: readonly DataConsoleEntry[],
  max: number = DATA_CONSOLE_MAX_ENTRIES
): DataConsoleEntry[] {
  if (incoming.length === 0) return current as DataConsoleEntry[]
  const bySeq = new Map<number, DataConsoleEntry>()
  for (const e of current) bySeq.set(e.seq, e)
  for (const e of incoming) bySeq.set(e.seq, e)
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  let statements = 0
  let metadata = 0
  const kept: DataConsoleEntry[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    const e = merged[i]
    if (e.source === 'metadata' ? metadata++ < max : statements++ < max) kept.push(e)
  }
  return kept.reverse()
}

export const useDataConsoleStore = create<DataConsoleState>()((set, get) => {
  const patch = (projectId: string, next: Partial<ConsoleProjectLog>): void =>
    set((s) => ({
      logs: { ...s.logs, [projectId]: { ...(s.logs[projectId] ?? EMPTY_LOG), ...next } }
    }))

  return {
    logs: {},
    showMetadata: readShowMetadata(),

    setShowMetadata: (show) => {
      set({ showMetadata: show })
      try {
        globalThis.localStorage?.setItem(SHOW_METADATA_KEY, show ? '1' : '0')
      } catch {
        // Remembering the choice is a convenience.
      }
    },

    load: async (projectId) => {
      patch(projectId, { status: 'loading', error: null })
      try {
        const response = await dataConsoleApi.list(projectId)
        const current = get().logs[projectId] ?? EMPTY_LOG
        // Events of the same server that arrived while listing are kept; another server's
        // numbers mean nothing next to these.
        const live = current.epoch === response.epoch ? current.entries : []
        patch(projectId, {
          entries: mergeConsoleEntries(live, response.entries),
          epoch: response.epoch,
          status: 'ready',
          error: null
        })
      } catch (error) {
        patch(projectId, {
          status: 'error',
          error: errorMessage(error, 'Could not load the console log')
        })
      }
    },

    sync: async (projectId) => {
      const held = get().logs[projectId]
      if (!held || held.status !== 'ready') {
        if (held?.status !== 'loading') await get().load(projectId)
        return
      }
      try {
        const response = await dataConsoleApi.list(projectId, held.entries.at(-1)?.seq)
        const current = get().logs[projectId] ?? EMPTY_LOG
        if (current.epoch !== response.epoch) {
          // Another server since: its numbers start over.
          await get().load(projectId)
          return
        }
        patch(projectId, { entries: mergeConsoleEntries(current.entries, response.entries) })
      } catch {
        // The next renewal tries again; the live channel keeps the list current meanwhile.
      }
    },

    apply: (event) => {
      const current = get().logs[event.dataProjectId] ?? EMPTY_LOG
      if (event.kind === 'cleared') {
        patch(event.dataProjectId, { entries: [], epoch: event.epoch })
        return
      }
      if (current.epoch !== null && current.epoch !== event.epoch) {
        // The server restarted: start over from its log.
        patch(event.dataProjectId, {
          entries: mergeConsoleEntries([], event.entries),
          epoch: event.epoch
        })
        void get().load(event.dataProjectId)
        return
      }
      patch(event.dataProjectId, {
        entries: mergeConsoleEntries(current.entries, event.entries),
        epoch: event.epoch
      })
    },

    clear: async (projectId) => {
      await dataConsoleApi.clear(projectId)
      patch(projectId, { entries: [] })
    },

    forget: (projectId) =>
      set((s) => {
        if (!(projectId in s.logs)) return s
        const logs = { ...s.logs }
        delete logs[projectId]
        return { logs }
      }),

    reset: () => set({ logs: {}, showMetadata: readShowMetadata() })
  }
})

/**
 * Follows a project's console while mounted: subscribes to the live channel first, then lists
 * (so nothing sent in between is missed), and lists the newer entries every CONSOLE_RENEW_MS
 * (the server's sign that a console follows the project). Returns the unsubscribe function.
 */
export function followDataConsole(projectId: string): () => void {
  const store = useDataConsoleStore.getState()
  const off = dataConsoleApi.onEvent((event) => {
    if (event.dataProjectId === projectId) useDataConsoleStore.getState().apply(event)
  })
  void store.load(projectId)
  const renew = setInterval(() => {
    void useDataConsoleStore.getState().sync(projectId)
  }, CONSOLE_RENEW_MS)
  return () => {
    clearInterval(renew)
    off()
  }
}
