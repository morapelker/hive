import { create } from 'zustand'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { detectSuggestion, type Suggestion } from '@/lib/run-suggestions/patterns'

// Module-level: active IPC subscriptions for run scripts, keyed by worktreeId.
// Keeps listeners alive regardless of which worktree the UI is showing.
const runSubscriptions = new Map<string, () => void>()

// RAF-throttle: tracks pending requestAnimationFrame handles per worktreeId.
// Only one RAF is scheduled per worktreeId at a time; subsequent appends within
// the same frame are buffer-only (no Zustand set()). Max ~60 re-renders/sec.
const pendingVersionBumps = new Map<string, number>()

const hasRAF = typeof requestAnimationFrame === 'function'

interface ScriptState {
  setupOutput: string[]
  setupRunning: boolean
  setupError: string | null
  runOutputVersion: number
  runRunning: boolean
  runPid: number | null
  activeSuggestion: Suggestion | null
  seenSignatures: Set<string>
}

function createDefaultScriptState(): ScriptState {
  return {
    setupOutput: [],
    setupRunning: false,
    setupError: null,
    runOutputVersion: 0,
    runRunning: false,
    runPid: null,
    activeSuggestion: null,
    seenSignatures: new Set()
  }
}

interface ScriptStore {
  scriptStates: Record<string, ScriptState>

  // Setup actions
  appendSetupOutput: (worktreeId: string, line: string) => void
  setSetupRunning: (worktreeId: string, running: boolean) => void
  setSetupError: (worktreeId: string, error: string | null) => void
  clearSetupOutput: (worktreeId: string) => void

  // Run actions
  appendRunOutput: (worktreeId: string, line: string) => void
  setRunRunning: (worktreeId: string, running: boolean) => void
  setRunPid: (worktreeId: string, pid: number | null) => void
  clearRunOutput: (worktreeId: string) => void
  getRunOutput: (worktreeId: string) => string[]
  setActiveSuggestion: (worktreeId: string, suggestion: Suggestion | null) => void
  markSuggestionSeen: (worktreeId: string, signature: string) => void
  dismissSuggestion: (worktreeId: string) => void
  clearSuggestions: (worktreeId: string) => void

  // Helpers
  getScriptState: (worktreeId: string) => ScriptState
}

export const useScriptStore = create<ScriptStore>((set, get) => ({
  scriptStates: {},

  appendSetupOutput: (worktreeId, line) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: {
            ...existing,
            setupOutput: [...existing.setupOutput, line]
          }
        }
      }
    })
  },

  setSetupRunning: (worktreeId, running) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, setupRunning: running }
        }
      }
    })
  },

  setSetupError: (worktreeId, error) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, setupError: error }
        }
      }
    })
  },

  clearSetupOutput: (worktreeId) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, setupOutput: [], setupError: null }
        }
      }
    })
  },

  appendRunOutput: (worktreeId, line) => {
    // O(1) mutation — no array copying
    const buffer = getOrCreateBuffer(worktreeId)
    buffer.append(line)

    // RAF-throttled version bump: schedule at most one set() per animation frame
    // per worktreeId. Subsequent appends within the same frame are buffer-only.
    if (hasRAF) {
      if (!pendingVersionBumps.has(worktreeId)) {
        // Use a sentinel to reserve the slot immediately. The rAF callback
        // deletes it, preventing the post-schedule set from re-inserting
        // a stale entry (matters when rAF fires synchronously in tests).
        pendingVersionBumps.set(worktreeId, -1)
        const handle = requestAnimationFrame(() => {
          pendingVersionBumps.delete(worktreeId)
          set((state) => {
            const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
            return {
              scriptStates: {
                ...state.scriptStates,
                [worktreeId]: {
                  ...existing,
                  runOutputVersion: existing.runOutputVersion + 1
                }
              }
            }
          })
        })
        // Only store the real handle if the callback hasn't already fired.
        // When rAF is synchronous (test mocks), the delete above already ran.
        if (pendingVersionBumps.has(worktreeId)) {
          pendingVersionBumps.set(worktreeId, handle)
        }
      }
    } else {
      // Fallback for environments without rAF (pure Node.js)
      set((state) => {
        const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
        return {
          scriptStates: {
            ...state.scriptStates,
            [worktreeId]: {
              ...existing,
              runOutputVersion: existing.runOutputVersion + 1
            }
          }
        }
      })
    }
  },

  setRunRunning: (worktreeId, running) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, runRunning: running }
        }
      }
    })
  },

  setRunPid: (worktreeId, pid) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, runPid: pid }
        }
      }
    })
  },

  clearRunOutput: (worktreeId) => {
    const buffer = getOrCreateBuffer(worktreeId)
    buffer.clear()

    // Cancel any pending RAF for this worktree — the buffer is now empty
    const pendingHandle = pendingVersionBumps.get(worktreeId)
    if (pendingHandle !== undefined) {
      if (pendingHandle !== -1) {
        cancelAnimationFrame(pendingHandle)
      }
      pendingVersionBumps.delete(worktreeId)
    }

    // Bump version synchronously so React sees the cleared state immediately
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: {
            ...existing,
            runOutputVersion: existing.runOutputVersion + 1,
            activeSuggestion: null,
            seenSignatures: new Set()
          }
        }
      }
    })
  },

  getRunOutput: (worktreeId: string): string[] => {
    const buffer = getOrCreateBuffer(worktreeId)
    return buffer.toArray()
  },

  setActiveSuggestion: (worktreeId, suggestion) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, activeSuggestion: suggestion }
        }
      }
    })
  },

  markSuggestionSeen: (worktreeId, signature) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: {
            ...existing,
            seenSignatures: new Set([...existing.seenSignatures, signature])
          }
        }
      }
    })
  },

  dismissSuggestion: (worktreeId) => {
    get().setActiveSuggestion(worktreeId, null)
  },

  clearSuggestions: (worktreeId) => {
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: {
            ...existing,
            activeSuggestion: null,
            seenSignatures: new Set()
          }
        }
      }
    })
  },

  getScriptState: (worktreeId) => {
    return get().scriptStates[worktreeId] || createDefaultScriptState()
  }
}))

/** Fire-and-forget: run project script for a worktree, subscribing to output events
 *  so output is captured even when RunTab is showing a different worktree. */
export function fireRunScript(worktreeId: string, commands: string[], cwd: string): void {
  const store = useScriptStore.getState()
  store.clearRunOutput(worktreeId)
  store.setRunRunning(worktreeId, true)

  // Tear down any existing subscription for this worktree (e.g. restart scenario)
  runSubscriptions.get(worktreeId)?.()

  const channel = `script:run:${worktreeId}`
  const unsub = window.scriptOps.onOutput(channel, (event) => {
    const s = useScriptStore.getState()
    switch (event.type) {
      case 'command-start':
        s.appendRunOutput(worktreeId, `\x00CMD:${event.command}`)
        break
      case 'output':
        if (event.data) {
          const lines = event.data.split('\n')
          for (const line of lines) {
            if (line === '') continue
            s.appendRunOutput(worktreeId, line)
            const suggestion = detectSuggestion(line)
            if (
              suggestion &&
              !s.getScriptState(worktreeId).seenSignatures.has(suggestion.signature)
            ) {
              s.markSuggestionSeen(worktreeId, suggestion.signature)
              s.setActiveSuggestion(worktreeId, suggestion)
            }
          }
        }
        break
      case 'long-running':
        // Show notification in output as a special marker (not mixed with actual output)
        s.appendRunOutput(
          worktreeId,
          `\x00NOTICE:Command is taking longer than expected (${event.elapsed}ms): ${event.command}`
        )
        break
      case 'error':
        s.appendRunOutput(worktreeId, `\x00ERR:Process exited with code ${event.exitCode}`)
        s.setRunRunning(worktreeId, false)
        s.setRunPid(worktreeId, null)
        runSubscriptions.delete(worktreeId)
        unsub()
        break
      case 'done':
        s.setRunRunning(worktreeId, false)
        s.setRunPid(worktreeId, null)
        runSubscriptions.delete(worktreeId)
        unsub()
        break
    }
  })

  runSubscriptions.set(worktreeId, unsub)

  window.scriptOps
    .runProject(commands, cwd, worktreeId)
    .then((envelope) => unwrapEnvelope(envelope))
    .then((result) => {
      if (result.success && result.pid) {
        useScriptStore.getState().setRunPid(worktreeId, result.pid)
      } else {
        useScriptStore.getState().setRunRunning(worktreeId, false)
        // Clean up subscription if start failed
        const sub = runSubscriptions.get(worktreeId)
        if (sub) {
          sub()
          runSubscriptions.delete(worktreeId)
        }
      }
    })
    .catch(() => {
      useScriptStore.getState().setRunRunning(worktreeId, false)
      const sub = runSubscriptions.get(worktreeId)
      if (sub) {
        sub()
        runSubscriptions.delete(worktreeId)
      }
    })
}

/** Kill a running project script and clean up its IPC subscription. */
export async function killRunScript(worktreeId: string): Promise<void> {
  unwrapEnvelope(await window.scriptOps.kill(worktreeId))
  useScriptStore.getState().setRunRunning(worktreeId, false)
  useScriptStore.getState().setRunPid(worktreeId, null)
  // The 'done'/'error' event callback will also try to clean up,
  // but we do it here too for immediate teardown on explicit kill.
  const sub = runSubscriptions.get(worktreeId)
  if (sub) {
    sub()
    runSubscriptions.delete(worktreeId)
  }
}
