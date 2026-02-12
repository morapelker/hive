import { create } from 'zustand'

export type TerminalStatus = 'creating' | 'running' | 'exited'

export interface TerminalInfo {
  status: TerminalStatus
  exitCode?: number
}

interface TerminalState {
  // Per-worktree terminal state
  terminals: Map<string, TerminalInfo>

  // Actions
  createTerminal: (
    worktreeId: string,
    cwd: string,
    shell?: string
  ) => Promise<{ success: boolean; error?: string }>
  destroyTerminal: (worktreeId: string) => Promise<void>
  /** Destroy the existing terminal and create a fresh one (for restarting exited processes) */
  restartTerminal: (
    worktreeId: string,
    cwd: string,
    shell?: string
  ) => Promise<{ success: boolean; error?: string }>
  setTerminalStatus: (worktreeId: string, status: TerminalStatus, exitCode?: number) => void
  getTerminal: (worktreeId: string) => TerminalInfo | undefined
  /** Check if a terminal exists and is in a given status */
  isTerminalAlive: (worktreeId: string) => boolean
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),

  createTerminal: async (worktreeId: string, _cwd: string, _shell?: string) => {
    const existing = get().terminals.get(worktreeId)
    if (existing && existing.status === 'running') {
      return { success: true }
    }

    // Mark as creating — actual PTY creation is handled by the backend (XtermBackend.mount)
    // The store only tracks state; the backend calls window.terminalOps.create() and
    // registers its own onData/onExit listeners to avoid duplicate listener registration.
    set((state) => {
      const terminals = new Map(state.terminals)
      terminals.set(worktreeId, { status: 'creating' })
      return { terminals }
    })

    return { success: true }
  },

  destroyTerminal: async (worktreeId: string) => {
    try {
      await window.terminalOps.destroy(worktreeId)
    } catch {
      // Best-effort destroy
    }
    set((state) => {
      const terminals = new Map(state.terminals)
      terminals.delete(worktreeId)
      return { terminals }
    })
  },

  setTerminalStatus: (worktreeId: string, status: TerminalStatus, exitCode?: number) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      terminals.set(worktreeId, { status, exitCode })
      return { terminals }
    })
  },

  getTerminal: (worktreeId: string) => {
    return get().terminals.get(worktreeId)
  },

  restartTerminal: async (worktreeId: string, cwd: string, shell?: string) => {
    // Destroy existing terminal first
    await get().destroyTerminal(worktreeId)
    // Create a fresh one
    return get().createTerminal(worktreeId, cwd, shell)
  },

  isTerminalAlive: (worktreeId: string) => {
    const terminal = get().terminals.get(worktreeId)
    return terminal !== undefined && terminal.status === 'running'
  }
}))
