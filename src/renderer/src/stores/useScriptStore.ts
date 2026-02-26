import { create } from 'zustand'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'

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
}

function createDefaultScriptState(): ScriptState {
  return {
    setupOutput: [],
    setupRunning: false,
    setupError: null,
    runOutputVersion: 0,
    runRunning: false,
    runPid: null
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
            const existing =
              state.scriptStates[worktreeId] || createDefaultScriptState()
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
            runOutputVersion: existing.runOutputVersion + 1
          }
        }
      }
    })
  },

  getRunOutput: (worktreeId: string): string[] => {
    const buffer = getOrCreateBuffer(worktreeId)
    return buffer.toArray()
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
        if (event.data) s.appendRunOutput(worktreeId, event.data)
        break
      case 'error':
        s.appendRunOutput(
          worktreeId,
          `\x00ERR:Process exited with code ${event.exitCode}`
        )
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

  window.scriptOps.runProject(commands, cwd, worktreeId).then((result) => {
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
}

/** Kill a running project script and clean up its IPC subscription. */
export async function killRunScript(worktreeId: string): Promise<void> {
  await window.scriptOps.kill(worktreeId)
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
