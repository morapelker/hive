/**
 * "New connection from projects" — what the New Connection dialog does, as one UI-neutral
 * function: a fresh worktree in every project, their setup scripts, then one connection over
 * those worktrees, with best-effort rollback of the worktrees when any step fails.
 *
 * Shared by useConnectionStore.quickCreateConnection (the dialog, Duplicate, a connection
 * project's "new instance"), the Tedooo agent's `create_connection` plan step and the phone's
 * `connection.create` relay command, so every entry point creates a connection the same way.
 * Never selects and never toasts: the caller decides what its UI does with the result.
 */
import { useConnectionStore } from '@/stores/useConnectionStore'
import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'
import type { ConnectionWithMembers } from '@shared/types/connection'

export interface ConnectionProjectInput {
  id: string
  path: string
  name: string
  kind?: 'git' | 'connection' | null
}

export interface CreateConnectionFromProjectsOptions {
  /** Link the connection to a saved connection project (it becomes one of its instances). */
  savedProjectId?: string
  /** Display name (connections.custom_name); null/blank keeps the derived "A + B" name. */
  customName?: string | null
  /**
   * Also save the connection as a connection project, which gives it its own board that
   * tickets can be launched into. Runs the store's saveConnectionAsProject, which selects the
   * new project on the desktop.
   */
  saveAsProject?: boolean
}

export type CreateConnectionFromProjectsResult =
  | {
      ok: true
      connectionId: string
      /** custom_name when one was applied, otherwise the derived "A + B" name. */
      connectionName: string
      connectionPath: string
      /** The connection project the connection belongs to, when saved or linked. */
      savedProjectId: string | null
      /**
       * The connection exists, but something asked on top of it did not happen (saving it as a
       * project). Never a reason to create it again.
       */
      warning?: string
    }
  | { ok: false; error: string }

/**
 * How many projects the agent and the phone may connect in one go; each one costs a git
 * worktree. The desktop dialog is not capped, so the helper itself enforces no maximum.
 */
export const CONNECTION_MAX_PROJECTS = 6

/** Insert a freshly-created connection into the store WITHOUT selecting it. */
export function insertConnectionLocally(connection: { id: string; members?: unknown[] }): void {
  useConnectionStore.setState((state) => {
    if (state.connections.some((c) => c.id === connection.id)) return state
    return {
      connections: [
        ...state.connections,
        connection as unknown as (typeof state.connections)[number]
      ]
    }
  })
}

function replaceConnectionLocally(connection: ConnectionWithMembers): void {
  useConnectionStore.setState((state) => ({
    connections: state.connections.map((c) =>
      c.id === connection.id ? (connection as unknown as (typeof state.connections)[number]) : c
    )
  }))
}

/**
 * Distinct, connectable projects in the order given. A connection project has no worktrees
 * of its own, so it can never be a member.
 */
export function connectableProjects<T extends ConnectionProjectInput>(projects: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const project of projects) {
    if (project.kind === 'connection' || seen.has(project.id)) continue
    seen.add(project.id)
    out.push(project)
  }
  return out
}

export async function createConnectionFromProjects(
  input: ConnectionProjectInput[],
  opts: CreateConnectionFromProjectsOptions = {}
): Promise<CreateConnectionFromProjectsResult> {
  const projects = connectableProjects(input)
  if (projects.length < 2) {
    return { ok: false, error: 'A connection needs at least 2 different projects.' }
  }

  // Dynamic import avoids a store cycle; fireSetupScript is a module-level export.
  const { useWorktreeStore, fireSetupScript } = await import('@/stores/useWorktreeStore')

  const created: {
    project: ConnectionProjectInput
    worktree: { id: string; path: string; branch_name: string }
  }[] = []

  // Best-effort rollback of every already-created worktree (per-item try/catch).
  const rollback = async (): Promise<void> => {
    for (const { project, worktree } of created) {
      try {
        const deleteResult = await worktreeApi.delete({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          branchName: worktree.branch_name,
          projectPath: project.path,
          archive: false
        })
        if (deleteResult.success) {
          useWorktreeStore.getState().removeWorktreeFromProject(project.id, worktree.id)
        }
      } catch {
        // Ignore rollback failures — this is a best-effort cleanup.
      }
    }
  }

  for (const project of projects) {
    let result: Awaited<ReturnType<typeof worktreeApi.create>>
    try {
      result = await worktreeApi.create({
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name
      })
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!result.success || !result.worktree) {
      await rollback()
      return {
        ok: false,
        error: `Failed to create worktree in "${project.name}": ${result.error ?? 'Unknown error'}`
      }
    }
    // Insert WITHOUT selecting — deliberately NOT the createWorktree action, which selects
    // the new worktree and closes open file tabs.
    useWorktreeStore.getState().addWorktreeToProject(project.id, result.worktree)
    created.push({ project, worktree: result.worktree })
  }

  // Only fire setup scripts once every worktree has been created successfully — the
  // per-project create loop above can still fail partway through and roll back (delete)
  // earlier directories, and we don't want setup scripts racing that deletion.
  for (const { project, worktree } of created) {
    fireSetupScript(project.id, worktree.id, worktree.path)
  }

  let createResult: Awaited<ReturnType<typeof connectionApi.create>>
  try {
    createResult = await connectionApi.create(
      created.map((c) => c.worktree.id),
      opts.savedProjectId ? { savedProjectId: opts.savedProjectId } : undefined
    )
  } catch (error) {
    createResult = {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (!createResult.success || !createResult.connection) {
    await rollback()
    return {
      ok: false,
      error: `Failed to create connection: ${createResult.error || 'Unknown error'}`
    }
  }
  let connection = createResult.connection
  // connectionOps.create silently skips worktrees it cannot find; a connection missing a
  // member is not the one that was asked for.
  if ((connection.members?.length ?? 0) !== created.length) {
    try {
      await connectionApi.delete(connection.id)
    } catch {
      // Best-effort cleanup only
    }
    await rollback()
    return { ok: false, error: 'The connection is missing some of its worktrees.' }
  }
  insertConnectionLocally(connection)

  // The display name is a rename after the fact (connections.name stays the derived one). A
  // failed rename is not worth undoing a working connection; the derived name is returned.
  const customName = opts.customName?.trim()
  if (customName) {
    try {
      const renamed = await connectionApi.rename(connection.id, customName)
      if (renamed.success && renamed.connection) {
        connection = renamed.connection
        replaceConnectionLocally(connection)
      }
    } catch {
      // Keep the derived name
    }
  }

  // The connection and its worktrees exist from here on, so a failed save is reported as a
  // warning on a successful result: a caller that saw a failure would retry and create them all
  // a second time.
  let savedProjectId: string | null = connection.saved_project_id ?? opts.savedProjectId ?? null
  let warning: string | undefined
  if (opts.saveAsProject && !savedProjectId) {
    savedProjectId = await useConnectionStore.getState().saveConnectionAsProject(connection.id)
    if (!savedProjectId) {
      warning = 'The connection was created, but saving it as a project failed.'
    }
  }

  return {
    ok: true,
    connectionId: connection.id,
    connectionName: connection.custom_name || connection.name,
    connectionPath: connection.path,
    savedProjectId,
    ...(warning ? { warning } : {})
  }
}
