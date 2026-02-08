import { create } from 'zustand'

interface ScriptState {
  setupOutput: string[]
  setupRunning: boolean
  setupError: string | null
  runOutput: string[]
  runRunning: boolean
  runPid: number | null
}

function createDefaultScriptState(): ScriptState {
  return {
    setupOutput: [],
    setupRunning: false,
    setupError: null,
    runOutput: [],
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
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: {
            ...existing,
            runOutput: [...existing.runOutput, line]
          }
        }
      }
    })
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
    set((state) => {
      const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
      return {
        scriptStates: {
          ...state.scriptStates,
          [worktreeId]: { ...existing, runOutput: [] }
        }
      }
    })
  },

  getScriptState: (worktreeId) => {
    return get().scriptStates[worktreeId] || createDefaultScriptState()
  }
}))
