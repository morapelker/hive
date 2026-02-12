import { create } from 'zustand'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'

// Session type with worktree/project metadata for display
interface SessionWithWorktree {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  worktree_name?: string
  worktree_branch_name?: string
  project_name?: string
}

interface SessionSearchFilters {
  keyword: string
  projectId: string | null
  worktreeId: string | null
  dateFrom: string | null
  dateTo: string | null
  includeArchived: boolean
}

interface SessionHistoryState {
  // Panel visibility
  isOpen: boolean

  // Search/filter state
  filters: SessionSearchFilters

  // Results
  searchResults: SessionWithWorktree[]
  isSearching: boolean
  error: string | null

  // Selection for preview
  selectedSessionId: string | null

  // Actions
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  setKeyword: (keyword: string) => void
  setProjectFilter: (projectId: string | null) => void
  setWorktreeFilter: (worktreeId: string | null) => void
  setDateFromFilter: (dateFrom: string | null) => void
  setDateToFilter: (dateTo: string | null) => void
  setIncludeArchived: (include: boolean) => void
  clearFilters: () => void
  performSearch: () => Promise<void>
  selectSession: (sessionId: string | null) => void
  getSelectedSession: () => SessionWithWorktree | null
  getSessionPreviewMessages: (
    session: SessionWithWorktree
  ) => Promise<Array<{ role: string; content: string }>>
}

const initialFilters: SessionSearchFilters = {
  keyword: '',
  projectId: null,
  worktreeId: null,
  dateFrom: null,
  dateTo: null,
  includeArchived: false
}

export const useSessionHistoryStore = create<SessionHistoryState>((set, get) => ({
  // Initial state
  isOpen: false,
  filters: { ...initialFilters },
  searchResults: [],
  isSearching: false,
  error: null,
  selectedSessionId: null,

  // Open panel
  openPanel: () => {
    set({ isOpen: true })
    // Perform initial search when opening
    get().performSearch()
  },

  // Close panel
  closePanel: () => {
    set({ isOpen: false, selectedSessionId: null })
  },

  // Toggle panel
  togglePanel: () => {
    const { isOpen } = get()
    if (isOpen) {
      get().closePanel()
    } else {
      get().openPanel()
    }
  },

  // Filter setters
  setKeyword: (keyword: string) => {
    set((state) => ({
      filters: { ...state.filters, keyword }
    }))
  },

  setProjectFilter: (projectId: string | null) => {
    set((state) => ({
      filters: { ...state.filters, projectId, worktreeId: null }
    }))
  },

  setWorktreeFilter: (worktreeId: string | null) => {
    set((state) => ({
      filters: { ...state.filters, worktreeId }
    }))
  },

  setDateFromFilter: (dateFrom: string | null) => {
    set((state) => ({
      filters: { ...state.filters, dateFrom }
    }))
  },

  setDateToFilter: (dateTo: string | null) => {
    set((state) => ({
      filters: { ...state.filters, dateTo }
    }))
  },

  setIncludeArchived: (include: boolean) => {
    set((state) => ({
      filters: { ...state.filters, includeArchived: include }
    }))
  },

  clearFilters: () => {
    set({ filters: { ...initialFilters } })
    get().performSearch()
  },

  // Perform search
  performSearch: async () => {
    set({ isSearching: true, error: null })
    try {
      const { filters } = get()
      const results = await window.db.session.search({
        keyword: filters.keyword || undefined,
        project_id: filters.projectId || undefined,
        worktree_id: filters.worktreeId || undefined,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
        includeArchived: filters.includeArchived
      })
      set({ searchResults: results, isSearching: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to search sessions',
        isSearching: false
      })
    }
  },

  // Select session for preview
  selectSession: (sessionId: string | null) => {
    set({ selectedSessionId: sessionId })
  },

  // Get selected session
  getSelectedSession: () => {
    const { searchResults, selectedSessionId } = get()
    if (!selectedSessionId) return null
    return searchResults.find((s) => s.id === selectedSessionId) || null
  },

  getSessionPreviewMessages: async (session: SessionWithWorktree) => {
    if (!session.opencode_session_id || !session.worktree_id) {
      return []
    }

    try {
      const worktree = await window.db.worktree.get(session.worktree_id)
      if (!worktree?.path) {
        return []
      }

      const result = await window.opencodeOps.getMessages(
        worktree.path,
        session.opencode_session_id
      )

      if (!result.success) {
        return []
      }

      return mapOpencodeMessagesToSessionViewMessages(result.messages)
        .slice(0, 5)
        .map((message) => ({
          role: message.role,
          content: message.content
        }))
    } catch {
      return []
    }
  }
}))

// Re-export the SessionWithWorktree type for use in components
export type { SessionWithWorktree, SessionSearchFilters }
