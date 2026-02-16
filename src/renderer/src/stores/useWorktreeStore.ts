import { create } from 'zustand'
import { useProjectStore } from './useProjectStore'
import { useScriptStore } from './useScriptStore'
import { useSessionStore } from './useSessionStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import type { SelectedModel } from './useSettingsStore'
import { toast } from '@/lib/toast'

// Worktree type matching the database schema
interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  branch_renamed: number // 0 = auto-named (city), 1 = user/auto renamed
  last_message_at: number | null // epoch ms of last AI message activity
  session_titles: string // JSON array of session title strings
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  created_at: string
  last_accessed_at: string
}

interface WorktreeState {
  // Data - keyed by project ID
  worktreesByProject: Map<string, Worktree[]>
  worktreeOrderByProject: Map<string, string[]>
  isLoading: boolean
  error: string | null

  // UI State
  selectedWorktreeId: string | null
  creatingForProjectId: string | null
  archivingWorktreeIds: Set<string>

  // Actions
  loadWorktrees: (projectId: string) => Promise<void>
  createWorktree: (
    projectId: string,
    projectPath: string,
    projectName: string
  ) => Promise<{ success: boolean; error?: string }>
  archiveWorktree: (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => Promise<{ success: boolean; error?: string }>
  unbranchWorktree: (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => Promise<{ success: boolean; error?: string }>
  selectWorktree: (id: string | null) => void
  selectWorktreeOnly: (id: string | null) => void
  touchWorktree: (id: string) => Promise<void>
  syncWorktrees: (projectId: string, projectPath: string) => Promise<void>
  getWorktreesForProject: (projectId: string) => Worktree[]
  getDefaultWorktree: (projectId: string) => Worktree | null
  setCreatingForProject: (projectId: string | null) => void
  duplicateWorktree: (
    projectId: string,
    projectPath: string,
    projectName: string,
    sourceBranch: string,
    sourceWorktreePath: string
  ) => Promise<{ success: boolean; worktree?: Worktree; error?: string }>
  updateWorktreeBranch: (worktreeId: string, newBranch: string) => void
  updateWorktreeModel: (worktreeId: string, model: SelectedModel) => void
  reorderWorktrees: (projectId: string, fromIndex: number, toIndex: number) => void
  appendSessionTitle: (worktreeId: string, title: string) => void
}

// Load persisted worktree order from localStorage
function loadPersistedOrder(): Map<string, string[]> {
  try {
    const raw = localStorage.getItem('hive-worktree-order')
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string[]>
      const map = new Map<string, string[]>()
      for (const [pid, order] of Object.entries(parsed)) {
        if (Array.isArray(order)) map.set(pid, order)
      }
      return map
    }
  } catch {
    // Ignore parse errors
  }
  return new Map()
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  // Initial state
  worktreesByProject: new Map(),
  worktreeOrderByProject: loadPersistedOrder(),
  isLoading: false,
  error: null,
  selectedWorktreeId: null,
  creatingForProjectId: null,
  archivingWorktreeIds: new Set(),

  // Load worktrees for a project from database
  loadWorktrees: async (projectId: string) => {
    set({ isLoading: true, error: null })
    try {
      const worktrees = await window.db.worktree.getActiveByProject(projectId)
      // Sort: non-default worktrees by last_accessed_at descending, default worktree last
      const sortedWorktrees = worktrees.sort((a, b) => {
        if (a.is_default && !b.is_default) return 1
        if (!a.is_default && b.is_default) return -1
        return new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
      })
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        newMap.set(projectId, sortedWorktrees)
        return { worktreesByProject: newMap, isLoading: false }
      })

      // Hydrate last-message timestamps from DB into the status store
      const statusStore = useWorktreeStatusStore.getState()
      for (const wt of sortedWorktrees) {
        if (wt.last_message_at) {
          statusStore.setLastMessageTime(wt.id, wt.last_message_at)
        }
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load worktrees',
        isLoading: false
      })
    }
  },

  // Create a new worktree
  createWorktree: async (projectId: string, projectPath: string, projectName: string) => {
    set({ creatingForProjectId: projectId })
    try {
      const result = await window.worktreeOps.create({
        projectId,
        projectPath,
        projectName
      })

      if (!result.success || !result.worktree) {
        set({ creatingForProjectId: null })
        return { success: false, error: result.error || 'Failed to create worktree' }
      }

      // Add to state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        const existingWorktrees = newMap.get(projectId) || []
        newMap.set(projectId, [result.worktree!, ...existingWorktrees])
        return {
          worktreesByProject: newMap,
          selectedWorktreeId: result.worktree!.id,
          creatingForProjectId: null
        }
      })

      // Fire-and-forget: run setup script if configured
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
      if (project?.setup_script) {
        const commands = project.setup_script
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))

        if (commands.length > 0) {
          const worktreeId = result.worktree!.id
          const cwd = result.worktree!.path
          useScriptStore.getState().setSetupRunning(worktreeId, true)
          window.scriptOps.runSetup(commands, cwd, worktreeId).catch(() => {
            useScriptStore.getState().setSetupRunning(worktreeId, false)
          })
        }
      }

      return { success: true }
    } catch (error) {
      set({ creatingForProjectId: null })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create worktree'
      }
    }
  },

  // Archive a worktree (remove worktree AND delete branch)
  archiveWorktree: async (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => {
    // Guard: block archive of default worktrees
    const worktrees = Array.from(get().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (worktree?.is_default) {
      toast.error('Cannot archive the default worktree')
      return { success: false, error: 'Cannot archive the default worktree' }
    }

    // Mark as archiving
    set((state) => ({
      archivingWorktreeIds: new Set([...state.archivingWorktreeIds, worktreeId])
    }))

    try {
      // 1. Kill running script process (dev server, build, etc.)
      const scriptState = useScriptStore.getState().scriptStates[worktreeId]
      if (scriptState?.runRunning) {
        try {
          await window.scriptOps.kill(worktreeId)
          useScriptStore.getState().setRunRunning(worktreeId, false)
        } catch {
          // Log but don't block archive — process may have already exited
        }
      }

      // 2. Abort any active streaming sessions
      const sessionIds = useSessionStore.getState().sessionsByWorktree.get(worktreeId) || []
      const statusStore = useWorktreeStatusStore.getState()
      for (const session of sessionIds) {
        const status = statusStore.sessionStatuses[session.id]
        if (status?.status === 'working' || status?.status === 'planning') {
          if (session.opencode_session_id) {
            try {
              await window.opencodeOps.abort(worktreePath, session.opencode_session_id)
            } catch {
              // Non-critical — session may already be idle
            }
          }
        }
      }

      // 3. Proceed with archive
      const result = await window.worktreeOps.delete({
        worktreeId,
        worktreePath,
        branchName,
        projectPath,
        archive: true
      })

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to archive worktree' }
      }

      // 4. Clean up any connections referencing this worktree
      try {
        await window.connectionOps.removeWorktreeFromAll(worktreeId)
        // Reload connections to reflect the change
        const { useConnectionStore } = await import('./useConnectionStore')
        await useConnectionStore.getState().loadConnections()
      } catch {
        // Non-critical -- log but don't block archive
      }

      // Remove from state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const filtered = worktrees.filter((w) => w.id !== worktreeId)
          if (filtered.length !== worktrees.length) {
            newMap.set(projectId, filtered)
          }
        }
        return {
          worktreesByProject: newMap,
          selectedWorktreeId:
            state.selectedWorktreeId === worktreeId ? null : state.selectedWorktreeId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive worktree'
      }
    } finally {
      // Always clear archiving state
      set((state) => {
        const next = new Set(state.archivingWorktreeIds)
        next.delete(worktreeId)
        return { archivingWorktreeIds: next }
      })
    }
  },

  // Unbranch a worktree (remove worktree but keep branch)
  unbranchWorktree: async (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => {
    // Guard: block unbranch of default worktrees
    const worktrees = Array.from(get().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (worktree?.is_default) {
      toast.error('Cannot unbranch the default worktree')
      return { success: false, error: 'Cannot unbranch the default worktree' }
    }

    // Mark as archiving (same loading state for unbranch)
    set((state) => ({
      archivingWorktreeIds: new Set([...state.archivingWorktreeIds, worktreeId])
    }))

    try {
      const result = await window.worktreeOps.delete({
        worktreeId,
        worktreePath,
        branchName,
        projectPath,
        archive: false
      })

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to unbranch worktree' }
      }

      // Clean up any connections referencing this worktree
      try {
        await window.connectionOps.removeWorktreeFromAll(worktreeId)
        const { useConnectionStore } = await import('./useConnectionStore')
        await useConnectionStore.getState().loadConnections()
      } catch {
        // Non-critical -- log but don't block unbranch
      }

      // Remove from state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const filtered = worktrees.filter((w) => w.id !== worktreeId)
          if (filtered.length !== worktrees.length) {
            newMap.set(projectId, filtered)
          }
        }
        return {
          worktreesByProject: newMap,
          selectedWorktreeId:
            state.selectedWorktreeId === worktreeId ? null : state.selectedWorktreeId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unbranch worktree'
      }
    } finally {
      // Always clear archiving state
      set((state) => {
        const next = new Set(state.archivingWorktreeIds)
        next.delete(worktreeId)
        return { archivingWorktreeIds: next }
      })
    }
  },

  // Select a worktree (with connection deconfliction)
  selectWorktree: (id: string | null) => {
    set({ selectedWorktreeId: id })
    if (id) {
      // Touch worktree to update last_accessed_at
      get().touchWorktree(id)
      // Deconflict: clear any selected connection
      import('./useConnectionStore').then(({ useConnectionStore }) => {
        if (useConnectionStore.getState().selectedConnectionId) {
          useConnectionStore.setState({ selectedConnectionId: null })
        }
      })
    }
  },

  // Select a worktree without triggering connection deconfliction
  // Used by connection store to avoid circular deconfliction
  selectWorktreeOnly: (id: string | null) => {
    set({ selectedWorktreeId: id })
    if (id) {
      get().touchWorktree(id)
    }
  },

  // Touch worktree (update last_accessed_at)
  touchWorktree: async (id: string) => {
    try {
      await window.db.worktree.touch(id)
      // Update local state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const updated = worktrees.map((w) =>
            w.id === id ? { ...w, last_accessed_at: new Date().toISOString() } : w
          )
          if (updated.some((w, i) => w !== worktrees[i])) {
            newMap.set(projectId, updated)
          }
        }
        return { worktreesByProject: newMap }
      })
    } catch {
      // Ignore touch errors
    }
  },

  // Sync worktrees with actual git state
  syncWorktrees: async (projectId: string, projectPath: string) => {
    try {
      await window.worktreeOps.sync({ projectId, projectPath })
      // Reload worktrees after sync
      await get().loadWorktrees(projectId)
    } catch {
      // Ignore sync errors
    }
  },

  // Get worktrees for a specific project (applies custom order if available)
  getWorktreesForProject: (projectId: string) => {
    const worktrees = get().worktreesByProject.get(projectId) || []

    // Separate default worktree (always last) from non-default
    const defaultWorktree = worktrees.find((w) => w.is_default)
    const nonDefault = worktrees.filter((w) => !w.is_default)

    const customOrder = get().worktreeOrderByProject.get(projectId)
    if (!customOrder || customOrder.length === 0) {
      return defaultWorktree ? [...nonDefault, defaultWorktree] : nonDefault
    }

    // Sort non-default worktrees by custom order; unordered ones go at end
    const ordered: typeof nonDefault = []
    for (const id of customOrder) {
      const wt = nonDefault.find((w) => w.id === id)
      if (wt) ordered.push(wt)
    }
    // Append any worktrees not in the custom order (newly created)
    for (const wt of nonDefault) {
      if (!customOrder.includes(wt.id)) ordered.push(wt)
    }

    return defaultWorktree ? [...ordered, defaultWorktree] : ordered
  },

  // Get the default worktree for a project
  getDefaultWorktree: (projectId: string) => {
    const worktrees = get().worktreesByProject.get(projectId) || []
    return worktrees.find((w) => w.is_default) ?? null
  },

  // Set the project ID that is currently creating a worktree
  setCreatingForProject: (projectId: string | null) => {
    set({ creatingForProjectId: projectId })
  },

  // Duplicate a worktree (clone branch with uncommitted state)
  duplicateWorktree: async (
    projectId: string,
    projectPath: string,
    projectName: string,
    sourceBranch: string,
    sourceWorktreePath: string
  ) => {
    try {
      const result = await window.worktreeOps.duplicate({
        projectId,
        projectPath,
        projectName,
        sourceBranch,
        sourceWorktreePath
      })
      if (result.success && result.worktree) {
        // Reload worktrees for the project
        get().loadWorktrees(projectId)
      }
      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate worktree'
      }
    }
  },

  // Update a worktree's branch name (and display name) in the store (after rename)
  updateWorktreeBranch: (worktreeId: string, newBranch: string) => {
    set((state) => {
      const newMap = new Map(state.worktreesByProject)
      for (const [projectId, worktrees] of newMap.entries()) {
        const updated = worktrees.map((w) =>
          w.id === worktreeId
            ? { ...w, name: newBranch, branch_name: newBranch, branch_renamed: 1 }
            : w
        )
        if (updated.some((w, i) => w !== worktrees[i])) {
          newMap.set(projectId, updated)
        }
      }
      return { worktreesByProject: newMap }
    })
  },

  // Update a worktree's last-used model in the store
  updateWorktreeModel: (worktreeId: string, model: SelectedModel) => {
    set((state) => {
      const newMap = new Map(state.worktreesByProject)
      for (const [projectId, worktrees] of newMap.entries()) {
        const updated = worktrees.map((w) =>
          w.id === worktreeId
            ? {
                ...w,
                last_model_provider_id: model.providerID,
                last_model_id: model.modelID,
                last_model_variant: model.variant ?? null
              }
            : w
        )
        if (updated.some((w, i) => w !== worktrees[i])) {
          newMap.set(projectId, updated)
        }
      }
      return { worktreesByProject: newMap }
    })
  },

  // Reorder non-default worktrees within a project via drag-and-drop
  reorderWorktrees: (projectId: string, fromIndex: number, toIndex: number) => {
    set((state) => {
      const worktrees = state.worktreesByProject.get(projectId) || []
      const nonDefault = worktrees.filter((w) => !w.is_default)

      // Build current order from existing custom order or derive from current array
      const existingOrder = state.worktreeOrderByProject.get(projectId)
      let order: string[]
      if (existingOrder && existingOrder.length > 0) {
        // Start from existing order, adding any new worktrees at end
        order = [...existingOrder]
        for (const wt of nonDefault) {
          if (!order.includes(wt.id)) order.push(wt.id)
        }
        // Remove any stale IDs (archived worktrees)
        order = order.filter((id) => nonDefault.some((w) => w.id === id))
      } else {
        order = nonDefault.map((w) => w.id)
      }

      if (fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) {
        return state
      }

      // Remove from old position and insert at new position
      const [removed] = order.splice(fromIndex, 1)
      order.splice(toIndex, 0, removed)

      const newOrderMap = new Map(state.worktreeOrderByProject)
      newOrderMap.set(projectId, order)

      // Persist to localStorage
      try {
        const serialized: Record<string, string[]> = {}
        for (const [pid, o] of newOrderMap.entries()) {
          serialized[pid] = o
        }
        localStorage.setItem('hive-worktree-order', JSON.stringify(serialized))
      } catch {
        // Ignore storage errors
      }

      return { worktreeOrderByProject: newOrderMap }
    })
  },

  // Append a session title to a worktree — updates DB and in-memory store
  appendSessionTitle: (worktreeId: string, title: string) => {
    // Update in-memory store immediately
    set((state) => {
      const newMap = new Map(state.worktreesByProject)
      for (const [projectId, worktrees] of newMap.entries()) {
        const updated = worktrees.map((w) => {
          if (w.id !== worktreeId) return w
          const titles: string[] = (() => {
            try {
              return JSON.parse(w.session_titles || '[]')
            } catch {
              return []
            }
          })()
          if (titles.includes(title)) return w
          return { ...w, session_titles: JSON.stringify([...titles, title]) }
        })
        if (updated.some((w, i) => w !== worktrees[i])) {
          newMap.set(projectId, updated)
        }
      }
      return { worktreesByProject: newMap }
    })

    // Persist to database (fire-and-forget)
    window.db.worktree.appendSessionTitle?.(worktreeId, title)
  }
}))
