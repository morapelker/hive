import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { ConnectionCreateProgress } from '@/lib/connection-create'
import type { SwitcherProject } from '@/lib/project-switcher'

/**
 * Whether a project can be one of several picked in the "Go to project" switcher
 * (Shift+Enter). Only a git project can: a connection is made of worktrees, and neither a
 * connection project nor a database has any of its own.
 */
export function canConnectSwitcherProject(project: Pick<SwitcherProject, 'kind'>): boolean {
  return project.kind === 'git'
}

/** A member of the new connection. `path` is the project's folder as stored, not shortened. */
export interface SwitcherConnectionProject {
  id: string
  name: string
  path: string
}

export interface ConnectSwitcherProjectsOptions {
  /** Told about each step (a worktree per project) as it starts and ends. */
  onProgress?: (progress: ConnectionCreateProgress) => void
  /** Handed the reason when nothing was created, in place of the store's error toast. */
  onError?: (error: string) => void
}

/**
 * Connects the projects picked in the "Go to project" switcher, the way the New Connection
 * dialog connects the projects ticked in it (the store's `quickCreateConnection`): a new
 * worktree in every project, in the order they were picked, then one connection over those
 * worktrees, which becomes the selected one. When a step fails the worktrees made so far are
 * removed and nothing is selected.
 *
 * Unlike the dialog there is no "Pull latest from origin" switch here: the "auto-pull before
 * worktree" setting decides, per worktree and best effort, as for a worktree created from the
 * sidebar.
 *
 * The Pinned Board is left, as when a project is opened from the switcher, so the user ends up
 * looking at the connection.
 *
 * Resolves to the new connection's id, or null when it was not created.
 */
export async function connectSwitcherProjects(
  projects: SwitcherConnectionProject[],
  options: ConnectSwitcherProjectsOptions = {}
): Promise<string | null> {
  let connectionId: string | null
  try {
    connectionId = await useConnectionStore.getState().quickCreateConnection(projects, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.onError?.(`Failed to create connection: ${message}`)
    return null
  }
  if (connectionId) useKanbanStore.getState().closePinnedBoard()
  return connectionId
}
