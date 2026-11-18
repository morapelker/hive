import { create } from 'zustand'

// Sidebar entity currently under the pointer. Board cards linked to it get a
// highlight ring (see `isTicketLinkedToSidebarTarget`).
export type SidebarHoverTarget =
  | { kind: 'project'; id: string }
  // Worktree hover highlights project-wide: `projectId` is the owning project,
  // resolved at hover time (null when the worktree store can't resolve it).
  | { kind: 'worktree'; id: string; projectId: string | null }
  // Connection hover highlights its connection project's whole board: `projectId`
  // is the saved connection project the connection is an instance of (null for an
  // ad-hoc connection, which only matches through sessions / member worktrees).
  | { kind: 'connection'; id: string; projectId: string | null }

interface SidebarHoverState {
  hoveredSidebarTarget: SidebarHoverTarget | null
  setHoveredSidebarTarget: (target: SidebarHoverTarget | null) => void
}

/**
 * Sidebar hover → board highlight.
 *
 * Why its own store: this changes on every row the pointer crosses. In the kanban store each
 * change was written to localStorage (that store is persisted, and persist saves on every
 * `set`) and ran the selectors of every kanban subscriber. Here it is never persisted and
 * only the ticket cards listen.
 */
export const useSidebarHoverStore = create<SidebarHoverState>()((set, get) => ({
  hoveredSidebarTarget: null,
  setHoveredSidebarTarget: (target) => {
    const current = get().hoveredSidebarTarget
    if (current === target) return
    if (
      current &&
      target &&
      current.kind === target.kind &&
      current.id === target.id &&
      (current.kind === 'project' ? null : current.projectId) ===
        (target.kind === 'project' ? null : target.projectId)
    ) {
      return
    }
    set({ hoveredSidebarTarget: target })
  }
}))
