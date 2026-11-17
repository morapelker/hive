import { randomUUID } from 'crypto'
import { existsSync, lstatSync, readdirSync, readlinkSync, unlinkSync } from 'fs'
import { join, sep } from 'path'
import { createLogger } from './logger'
import {
  createConnectionDir,
  createConnectionProjectDir,
  createSymlink,
  removeSymlink,
  deleteConnectionDir,
  generateConnectionInstructions,
  deriveSymlinkName,
  generateConnectionColor
} from './connection-service'
import type { DatabaseService } from '../db/database'
import type { ConnectionWithMembers, Project } from '../db/types'
import type { RecentConnectionEntry, RecentConnectionProject } from '../../shared/types/connection'
import type { RelocationMove } from './dev-folder/types'

const log = createLogger({ component: 'ConnectionOps' })

/**
 * Record a connection's project set into connection history.
 * History failures must never fail the parent operation, so all errors are
 * swallowed after logging a warning. (<2 distinct projects is already a
 * silent no-op inside DatabaseService.upsertConnectionHistory.)
 */
export function recordConnectionHistory(db: DatabaseService, projectIds: string[]): void {
  try {
    db.upsertConnectionHistory(projectIds)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to record connection history', { error: message })
  }
}

/**
 * Derive a display name for a connection from its member project names.
 */
export function deriveConnectionName(connection: ConnectionWithMembers): string {
  const projectNames = [...new Set(connection.members.map((m) => m.project_name))]
  return projectNames.join(' + ') || 'Connection'
}

/**
 * Build the AgentsMdMember array from the enriched connection data.
 */
export function buildAgentsMdMembers(
  connection: ConnectionWithMembers
): { symlinkName: string; projectName: string; branchName: string; worktreePath: string }[] {
  return connection.members.map((m) => ({
    symlinkName: m.symlink_name,
    projectName: m.project_name,
    branchName: m.worktree_branch,
    worktreePath: m.worktree_path
  }))
}

export function getAllConnectionsOp(db: DatabaseService): {
  success: boolean
  connections?: ConnectionWithMembers[]
  error?: string
} {
  try {
    const connections = db.getAllConnections()
    return { success: true, connections }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Get all connections failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

export function getConnectionOp(
  db: DatabaseService,
  connectionId: string
): { success: boolean; connection?: ConnectionWithMembers; error?: string } {
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    return { success: true, connection }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Get connection failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

export function getPinnedConnectionsOp(db: DatabaseService): ConnectionWithMembers[] {
  return db.getPinnedConnections()
}

/**
 * Create a new connection from a set of worktree IDs.
 * Creates the filesystem directory, DB record, symlinks, members, derives the name,
 * and generates AGENTS.md instructions.
 */
export async function createConnectionOp(
  db: DatabaseService,
  worktreeIds: string[],
  savedProjectId?: string | null,
  options?: {
    /**
     * Create the BASE instance of a connection project (connections.is_base = 1):
     * members are the member projects' default worktrees. Not recorded in
     * connection history (it is a structural artifact, not a user launch).
     */
    isBase?: boolean
  }
): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> {
  const isBase = options?.isBase === true
  log.info('Creating connection', { worktreeCount: worktreeIds.length, savedProjectId, isBase })
  try {
    // Use a short random ID for the directory name (avoids filesystem issues with special chars)
    const dirName = randomUUID().slice(0, 8)
    const dirPath = createConnectionDir(dirName)

    // Create the DB connection record with placeholder name and a random color,
    // preferring one no existing connection is using
    const usedColors = db
      .getAllConnections()
      .map((c) => c.color)
      .filter((c): c is string => c !== null)
    const color = generateConnectionColor(usedColors)
    const connection = db.createConnection({
      name: dirName,
      path: dirPath,
      color,
      saved_project_id: savedProjectId ?? null,
      is_base: isBase ? 1 : 0
    })

    // For each worktree, look up its data, derive symlink name, create symlink + member
    const existingSymlinkNames: string[] = []

    for (const worktreeId of worktreeIds) {
      const worktree = db.getWorktree(worktreeId)
      if (!worktree) {
        log.warn('Worktree not found, skipping', { worktreeId })
        continue
      }

      const project = db.getProject(worktree.project_id)
      if (!project) {
        log.warn('Project not found, skipping', { projectId: worktree.project_id })
        continue
      }

      const symlinkName = deriveSymlinkName(project.name, existingSymlinkNames)
      existingSymlinkNames.push(symlinkName)

      const symlinkPath = join(dirPath, symlinkName)
      createSymlink(worktree.path, symlinkPath)

      db.createConnectionMember({
        connection_id: connection.id,
        worktree_id: worktreeId,
        project_id: project.id,
        symlink_name: symlinkName
      })
    }

    // Derive the display name from member project names and update the DB
    const enriched = db.getConnection(connection.id)
    if (enriched) {
      const derivedName = deriveConnectionName(enriched)
      db.updateConnection(connection.id, { name: derivedName })
      generateConnectionInstructions(dirPath, buildAgentsMdMembers(enriched))
      if (!isBase) {
        recordConnectionHistory(
          db,
          enriched.members.map((m) => m.project_id)
        )
      }
    }

    // Re-fetch to get the final state with derived name
    const final = db.getConnection(connection.id)
    log.info('Connection created', {
      id: connection.id,
      name: final?.name,
      memberCount: worktreeIds.length
    })
    return { success: true, connection: final ?? undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Connection creation failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/** Error returned by every op that would delete or reshape a connection project's base instance. */
export const BASE_INSTANCE_LOCKED_ERROR =
  'The base connection of a connection project cannot be deleted or changed'

/**
 * A base instance is locked only while its connection project exists. An
 * is_base row whose saved_project_id was nulled (project removed by a path that
 * could not take the base down) is an orphan and must stay deletable — the
 * next listing clears its flag (see ensureConnectionProjectBaseInstancesOp).
 */
export function isLockedBaseInstance(connection: {
  is_base?: number | null
  saved_project_id?: string | null
}): boolean {
  return !!connection.is_base && !!connection.saved_project_id
}

/**
 * Delete a connection (filesystem directory + DB record).
 * The base instance of a connection project is refused unless `force` is set
 * (only the connection project's own removal may take it down).
 */
export async function deleteConnectionOp(
  db: DatabaseService,
  connectionId: string,
  options?: { force?: boolean }
): Promise<{ success: boolean; error?: string }> {
  log.info('Deleting connection', { connectionId })
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    if (isLockedBaseInstance(connection) && !options?.force) {
      return { success: false, error: BASE_INSTANCE_LOCKED_ERROR }
    }

    // Remove the filesystem directory (which contains the symlinks)
    deleteConnectionDir(connection.path)

    // Delete from DB (cascade removes connection_members)
    db.deleteConnection(connectionId)

    log.info('Connection deleted', { connectionId, name: connection.name })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Connection deletion failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Rename a connection (set or clear custom_name).
 */
export async function renameConnectionOp(
  db: DatabaseService,
  connectionId: string,
  customName: string | null
): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> {
  log.info('Renaming connection', { connectionId, customName })
  try {
    const existing = db.getConnection(connectionId)
    if (!existing) {
      return { success: false, error: 'Connection not found' }
    }

    db.updateConnection(connectionId, { custom_name: customName || null })
    const updated = db.getConnection(connectionId)
    log.info('Connection renamed', { connectionId, customName: updated?.custom_name })
    return { success: true, connection: updated ?? undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Connection rename failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Pin or unpin a connection.
 */
export function setConnectionPinnedOp(
  db: DatabaseService,
  connectionId: string,
  pinned: boolean
): { success: boolean; error?: string } {
  try {
    db.updateConnection(connectionId, { pinned: pinned ? 1 : 0 })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Set connection pinned failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Add a member (worktree) to an existing connection.
 * Creates symlink, DB member record, re-derives connection name, and regenerates AGENTS.md.
 */
export async function addConnectionMemberOp(
  db: DatabaseService,
  connectionId: string,
  worktreeId: string
): Promise<{
  success: boolean
  member?: ConnectionWithMembers['members'][0]
  error?: string
}> {
  log.info('Adding member to connection', { connectionId, worktreeId })
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    if (isLockedBaseInstance(connection)) {
      return { success: false, error: BASE_INSTANCE_LOCKED_ERROR }
    }

    const worktree = db.getWorktree(worktreeId)
    if (!worktree) {
      return { success: false, error: 'Worktree not found' }
    }

    const project = db.getProject(worktree.project_id)
    if (!project) {
      return { success: false, error: 'Project not found' }
    }

    // Derive a unique symlink name (avoid collisions with existing members)
    const existingNames = connection.members.map((m) => m.symlink_name)
    const symlinkName = deriveSymlinkName(project.name, existingNames)

    // Create the symlink on disk
    const symlinkPath = join(connection.path, symlinkName)
    createSymlink(worktree.path, symlinkPath)

    // Insert the member DB row
    const member = db.createConnectionMember({
      connection_id: connectionId,
      worktree_id: worktreeId,
      project_id: project.id,
      symlink_name: symlinkName
    })

    // Re-derive connection name and regenerate AGENTS.md
    const updated = db.getConnection(connectionId)
    if (updated) {
      const derivedName = deriveConnectionName(updated)
      db.updateConnection(connectionId, { name: derivedName })
      generateConnectionInstructions(updated.path, buildAgentsMdMembers(updated))
    }

    log.info('Member added to connection', {
      connectionId,
      worktreeId,
      symlinkName
    })
    return {
      success: true,
      member: {
        ...member,
        worktree_name: worktree.name,
        worktree_branch: worktree.branch_name,
        worktree_path: worktree.path,
        project_name: project.name
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Add member failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Remove a member from a connection. If last member, delete the entire connection.
 */
export async function removeConnectionMemberOp(
  db: DatabaseService,
  connectionId: string,
  worktreeId: string
): Promise<{ success: boolean; connectionDeleted?: boolean; error?: string }> {
  log.info('Removing member from connection', { connectionId, worktreeId })
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    if (isLockedBaseInstance(connection)) {
      return { success: false, error: BASE_INSTANCE_LOCKED_ERROR }
    }

    // Find the member to get symlink name for removal
    const member = connection.members.find((m) => m.worktree_id === worktreeId)
    if (!member) {
      return { success: false, error: 'Member not found in connection' }
    }

    // Remove the symlink from disk
    const symlinkPath = join(connection.path, member.symlink_name)
    removeSymlink(symlinkPath)

    // Delete the member DB row
    db.deleteConnectionMember(connectionId, worktreeId)

    // Check if this was the last member
    const remaining = db.getConnection(connectionId)
    if (!remaining || remaining.members.length === 0) {
      // Delete the entire connection
      deleteConnectionDir(connection.path)
      db.deleteConnection(connectionId)
      log.info('Connection deleted (last member removed)', { connectionId })
      return { success: true, connectionDeleted: true }
    }

    // Re-derive connection name and regenerate AGENTS.md with remaining members
    const derivedName = deriveConnectionName(remaining)
    db.updateConnection(connectionId, { name: derivedName })
    generateConnectionInstructions(remaining.path, buildAgentsMdMembers(remaining))

    log.info('Member removed from connection', { connectionId, worktreeId })
    return { success: true, connectionDeleted: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Remove member failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Batch-update a connection's members to match a desired set of worktree IDs.
 * Diffs the desired set against the current members, applies adds before
 * removes (so the connection never goes transiently empty), and records
 * exactly one history entry for the final member set.
 */
export async function updateConnectionMembersOp(
  db: DatabaseService,
  connectionId: string,
  worktreeIds: string[]
): Promise<{
  success: boolean
  connection?: ConnectionWithMembers
  connectionDeleted?: boolean
  error?: string
}> {
  log.info('Updating connection members', { connectionId, worktreeCount: worktreeIds.length })
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    if (isLockedBaseInstance(connection)) {
      return { success: false, error: BASE_INSTANCE_LOCKED_ERROR }
    }

    const desired = [...new Set(worktreeIds)]
    const current = connection.members.map((m) => m.worktree_id)
    const toAdd = desired.filter((id) => !current.includes(id))
    const toRemove = current.filter((id) => !desired.includes(id))

    for (const worktreeId of toAdd) {
      const result = await addConnectionMemberOp(db, connectionId, worktreeId)
      if (!result.success) {
        return { success: false, error: result.error }
      }
    }

    for (const worktreeId of toRemove) {
      const result = await removeConnectionMemberOp(db, connectionId, worktreeId)
      if (!result.success) {
        return { success: false, error: result.error }
      }
      if (result.connectionDeleted) {
        // Defensive: unreachable in practice since adds run first and
        // worktreeIds is required to be non-empty at the RPC boundary.
        log.warn('Connection deleted mid-update', { connectionId })
        return { success: true, connectionDeleted: true }
      }
    }

    const final = db.getConnection(connectionId)
    if (final) {
      recordConnectionHistory(
        db,
        final.members.map((m) => m.project_id)
      )
    }

    log.info('Connection members updated', { connectionId })
    return { success: true, connection: final ?? undefined }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Update connection members failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * Remove a worktree from ALL connections it belongs to.
 * Used by the archive cascade -- when a worktree is archived, clean up its connections.
 */
export async function removeWorktreeFromAllConnectionsOp(
  db: DatabaseService,
  worktreeId: string
): Promise<{ success: boolean; error?: string }> {
  log.info('Removing worktree from all connections', { worktreeId })
  try {
    const memberships = db.getConnectionMembersByWorktree(worktreeId)

    if (memberships.length === 0) {
      return { success: true }
    }

    for (const membership of memberships) {
      const connection = db.getConnection(membership.connection_id)
      if (!connection) continue

      // Find member entry to get symlink name
      const member = connection.members.find((m) => m.worktree_id === worktreeId)
      if (member) {
        const symlinkPath = join(connection.path, member.symlink_name)
        removeSymlink(symlinkPath)
      }

      // Delete the member row
      db.deleteConnectionMember(membership.connection_id, worktreeId)

      // If no members remain, delete the entire connection
      const remaining = db.getConnection(membership.connection_id)
      if (!remaining || remaining.members.length === 0) {
        deleteConnectionDir(connection.path)
        db.deleteConnection(membership.connection_id)
        log.info('Connection deleted (last member removed via cascade)', {
          connectionId: membership.connection_id
        })
      } else {
        // Re-derive connection name and regenerate AGENTS.md for remaining members
        const derivedName = deriveConnectionName(remaining)
        db.updateConnection(membership.connection_id, { name: derivedName })
        generateConnectionInstructions(remaining.path, buildAgentsMdMembers(remaining))
      }
    }

    log.info('Worktree removed from all connections', {
      worktreeId,
      connectionCount: memberships.length
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Remove worktree from all connections failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * Fetch recent connection history, resolving each entry's project IDs to
 * live project data. Entries referencing a deleted project (or that no
 * longer have at least 2 distinct projects) are dropped entirely.
 */
export function getRecentConnectionsOp(db: DatabaseService): {
  success: boolean
  entries?: RecentConnectionEntry[]
  error?: string
} {
  try {
    const rows = db.getRecentConnectionHistory(50)
    const entries: RecentConnectionEntry[] = []

    for (const row of rows) {
      const projectIds = JSON.parse(row.project_ids) as string[]
      const projects: RecentConnectionProject[] = []

      for (const projectId of projectIds) {
        const project = db.getProject(projectId)
        if (!project) break
        projects.push({ id: project.id, name: project.name, path: project.path })
      }

      if (projects.length !== projectIds.length || projects.length < 2) continue

      entries.push({
        id: row.id,
        project_set_key: row.project_set_key,
        projects,
        last_used_at: row.last_used_at,
        use_count: row.use_count,
        note: row.note ?? null
      })
    }

    return { success: true, entries: entries.slice(0, 15) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Get recent connections failed', error instanceof Error ? error : new Error(message))
    return { success: false, error: message }
  }
}

/**
 * Set or clear the note on a recent-connection history entry. Empty or
 * whitespace-only notes are normalized to null (clears the note).
 */
export function setRecentConnectionNoteOp(
  db: DatabaseService,
  entryId: string,
  note: string | null
): { success: boolean; error?: string } {
  log.info('Setting recent connection note', { entryId })
  try {
    const normalized = note && note.trim() ? note.trim() : null
    if (!db.setConnectionHistoryNote(entryId, normalized)) {
      return { success: false, error: 'Recent connection not found' }
    }
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Set recent connection note failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * Promote a connection into a standalone "connection project": a projects row
 * (kind='connection') that owns its own kanban board, listed in the sidebar's
 * Projects section. The project's path is a dedicated directory of symlinks to
 * the member project ROOTS (not the connection's worktrees) so it survives the
 * source connection being deleted. The source connection is linked back via
 * connections.saved_project_id and becomes the project's first "instance".
 */
export async function saveConnectionAsProjectOp(
  db: DatabaseService,
  connectionId: string
): Promise<{
  success: boolean
  project?: Project
  connection?: ConnectionWithMembers
  /** The project's base instance (default worktree of every member), when it could be created. */
  baseConnection?: ConnectionWithMembers
  error?: string
}> {
  log.info('Saving connection as project', { connectionId })
  let createdDirPath: string | null = null
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
    }
    if (connection.saved_project_id) {
      return { success: false, error: 'Connection is already saved as a project' }
    }

    // Distinct member project ids, in member order
    const memberProjectIds = [...new Set(connection.members.map((m) => m.project_id))]
    if (memberProjectIds.length < 2) {
      return { success: false, error: 'Connection needs at least 2 projects to save as a project' }
    }

    const projects = memberProjectIds
      .map((id) => db.getProject(id))
      .filter((p): p is Project => p !== null)
    if (projects.length !== memberProjectIds.length) {
      return { success: false, error: 'A member project no longer exists' }
    }

    // Create the project directory with symlinks to each member project root
    const dirName = randomUUID().slice(0, 8)
    const dirPath = createConnectionProjectDir(dirName)
    createdDirPath = dirPath
    const existingSymlinkNames: string[] = []
    const agentsMdMembers: {
      symlinkName: string
      projectName: string
      branchName: string
      worktreePath: string
    }[] = []
    for (const project of projects) {
      const symlinkName = deriveSymlinkName(project.name, existingSymlinkNames)
      existingSymlinkNames.push(symlinkName)
      createSymlink(project.path, join(dirPath, symlinkName))
      const defaultWorktree = db.getWorktreesByProject(project.id).find((w) => w.is_default)
      agentsMdMembers.push({
        symlinkName,
        projectName: project.name,
        branchName: defaultWorktree?.branch_name || 'default',
        worktreePath: project.path
      })
    }
    generateConnectionInstructions(dirPath, agentsMdMembers)

    const name = connection.custom_name || deriveConnectionName(connection)
    const project = db.createConnectionProject({
      name,
      path: dirPath,
      member_project_ids: memberProjectIds
    })

    // Link the source connection back to the saved project — it becomes the
    // project's first instance.
    db.updateConnection(connectionId, { saved_project_id: project.id })

    // The project's base instance: each member project's default worktree
    // connected together — the twin of a regular project's default worktree
    // (always present, never archivable). Failure here must not fail the save;
    // getAllConnectionsOp heals a missing base on the next listing. NOTE: this
    // can PROMOTE the source itself (a connection already spanning the member
    // default worktrees), so read the source back only afterwards.
    const baseConnection = (await ensureBaseInstanceForConnectionProjectOp(db, project)) ?? undefined
    const updatedConnection = db.getConnection(connectionId) ?? undefined

    log.info('Connection saved as project', {
      connectionId,
      projectId: project.id,
      memberCount: memberProjectIds.length,
      baseConnectionId: baseConnection?.id ?? null
    })
    return { success: true, project, connection: updatedConnection, baseConnection }
  } catch (error) {
    // Best-effort: don't leak the half-built project directory on failure.
    if (createdDirPath) {
      try {
        deleteConnectionDir(createdDirPath)
      } catch {
        // Cleanup is best-effort only.
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Save connection as project failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * Add a git project to a connection project (`projects.member_project_ids`): links the member's
 * root into the project directory under a free symlink name, as `saveConnectionAsProjectOp`
 * does, re-generates the directory's AGENTS.md and rebuilds the project's base instance over
 * the new member set. Idempotent for a project that is already a member.
 */
export async function addConnectionProjectMemberOp(
  db: DatabaseService,
  projectId: string,
  memberProjectId: string
): Promise<{ success: boolean; project?: Project; error?: string }> {
  log.info('Adding member to connection project', { projectId, memberProjectId })
  try {
    const project = db.getProject(projectId)
    if (!project) return { success: false, error: 'Connection project not found' }
    if (project.kind !== 'connection') {
      return { success: false, error: 'Not a connection project' }
    }
    const member = db.getProject(memberProjectId)
    if (!member) return { success: false, error: 'Member project not found' }
    if (member.kind === 'connection') {
      return { success: false, error: 'A connection project cannot be a member of another' }
    }
    const memberIds = parseMemberProjectIds(project.member_project_ids)
    if (memberIds.includes(memberProjectId)) return { success: true, project }

    // The project directory links every member root; the new one gets a free name.
    const agentsMdMembers = buildConnectionProjectAgentsMdMembers(db, [
      ...memberIds,
      memberProjectId
    ])
    const added = agentsMdMembers.find((m) => m.projectId === memberProjectId)
    if (added) createSymlink(added.worktreePath, join(project.path, added.symlinkName))
    try {
      generateConnectionInstructions(project.path, agentsMdMembers)
    } catch (error) {
      log.warn('Could not regenerate the connection project instructions', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    const updated = db.updateConnectionProjectMembers(projectId, [...memberIds, memberProjectId])
    if (!updated) return { success: false, error: 'Connection project not found' }
    // The base instance spans the member default worktrees: rebuilt over the new set. Never
    // fatal — the next connection listing heals a missing base.
    await ensureBaseInstanceForConnectionProjectOp(db, updated)
    log.info('Member added to connection project', { projectId, memberProjectId })
    return { success: true, project: updated }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Add member to connection project failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * Replace the member set of a connection project (`projects.member_project_ids`) — the "edit
 * connection project" op. Every FUTURE instance (ticket launches, "+", document runs, the base)
 * is built from the new member set; instances that already exist keep the members they were
 * created with (their rows own their member lists), so running sessions are never touched.
 *
 * On disk the project directory is reconciled with the symlink set `saveConnectionAsProjectOp`
 * would have produced for the new member order: removed (or renamed) member links are dropped,
 * new ones created, AGENTS.md regenerated. The base instance is then rebuilt over the new
 * members' default worktrees (a stale base is demoted to an ordinary, deletable instance — any
 * session on it keeps working).
 */
export async function updateConnectionProjectMembersOp(
  db: DatabaseService,
  projectId: string,
  memberProjectIds: string[]
): Promise<{ success: boolean; project?: Project; error?: string }> {
  log.info('Updating connection project members', { projectId, memberProjectIds })
  try {
    const project = db.getProject(projectId)
    if (!project) return { success: false, error: 'Connection project not found' }
    if (project.kind !== 'connection') {
      return { success: false, error: 'Not a connection project' }
    }

    const desiredIds = [...new Set(memberProjectIds.filter((id) => id.length > 0))]
    if (desiredIds.length < 2) {
      return { success: false, error: 'A connection project needs at least 2 member projects' }
    }
    const desiredMembers: Project[] = []
    for (const id of desiredIds) {
      const member = db.getProject(id)
      if (!member) return { success: false, error: 'Member project not found' }
      if (member.kind === 'connection') {
        return { success: false, error: 'A connection project cannot be a member of another' }
      }
      desiredMembers.push(member)
    }

    const currentIds = parseMemberProjectIds(project.member_project_ids)
    if (currentIds.join('\0') === desiredIds.join('\0')) return { success: true, project }

    // Symlink names are derived in member order (collisions get a -2 suffix), so compute the
    // old and new name per member id and reconcile the directory by diffing the two maps.
    const currentNames = deriveMemberSymlinkNames(db, currentIds)
    const desiredNames = new Map<string, string>()
    const existingNames: string[] = []
    const agentsMdMembers: {
      symlinkName: string
      projectName: string
      branchName: string
      worktreePath: string
    }[] = []
    for (const member of desiredMembers) {
      const symlinkName = deriveSymlinkName(member.name, existingNames)
      existingNames.push(symlinkName)
      desiredNames.set(member.id, symlinkName)
      const defaultWorktree = db.getWorktreesByProject(member.id).find((w) => w.is_default)
      agentsMdMembers.push({
        symlinkName,
        projectName: member.name,
        branchName: defaultWorktree?.branch_name || 'default',
        worktreePath: member.path
      })
    }

    // Removes first so a renamed member never collides with its own old link.
    for (const [id, name] of currentNames) {
      if (desiredNames.get(id) !== name) removeSymlink(join(project.path, name))
    }
    for (const member of desiredMembers) {
      const name = desiredNames.get(member.id)!
      if (currentNames.get(member.id) !== name) {
        createSymlink(member.path, join(project.path, name))
      }
    }
    try {
      generateConnectionInstructions(project.path, agentsMdMembers)
    } catch (error) {
      log.warn('Could not regenerate the connection project instructions', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    const updated = db.updateConnectionProjectMembers(projectId, desiredIds)
    if (!updated) return { success: false, error: 'Connection project not found' }
    // Base instance over the new members' default worktrees. Never fatal — the next
    // connection listing heals a missing base.
    await ensureBaseInstanceForConnectionProjectOp(db, updated)
    log.info('Connection project members updated', {
      projectId,
      added: desiredIds.filter((id) => !currentIds.includes(id)),
      removed: currentIds.filter((id) => !desiredIds.includes(id))
    })
    return { success: true, project: updated }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(
      'Update connection project members failed',
      error instanceof Error ? error : new Error(message)
    )
    return { success: false, error: message }
  }
}

/**
 * The symlink name each member id currently has inside a connection project directory —
 * `deriveSymlinkName` replayed over the stored member order, exactly as the save/add ops
 * assigned them. Members whose project row is gone are skipped (their link, if any, is
 * left alone: its name can no longer be derived).
 */
function deriveMemberSymlinkNames(db: DatabaseService, memberIds: string[]): Map<string, string> {
  const names = new Map<string, string>()
  const existing: string[] = []
  for (const id of memberIds) {
    const member = db.getProject(id)
    if (!member) continue
    const name = deriveSymlinkName(member.name, existing)
    existing.push(name)
    names.set(id, name)
  }
  return names
}

/** One member as AGENTS.md / CLAUDE.md lists it, with the project it stands for. */
type ConnectionProjectAgentsMdMember = ReturnType<typeof buildAgentsMdMembers>[number] & {
  projectId: string
}

/**
 * The members of a connection project as its AGENTS.md / CLAUDE.md lists them: every member
 * project that still exists, in member order, under the link name `deriveSymlinkName` gives it
 * in that order, with its root folder and the branch of its default worktree.
 */
function buildConnectionProjectAgentsMdMembers(
  db: DatabaseService,
  memberProjectIds: readonly string[]
): ConnectionProjectAgentsMdMember[] {
  const existingNames: string[] = []
  const members: ConnectionProjectAgentsMdMember[] = []
  for (const id of memberProjectIds) {
    const memberProject = db.getProject(id)
    if (!memberProject) continue
    const symlinkName = deriveSymlinkName(memberProject.name, existingNames)
    existingNames.push(symlinkName)
    const defaultWorktree = db.getWorktreesByProject(id).find((w) => w.is_default)
    members.push({
      projectId: id,
      symlinkName,
      projectName: memberProject.name,
      branchName: defaultWorktree?.branch_name || 'default',
      worktreePath: memberProject.path
    })
  }
  return members
}

// ── Connection project base instances ─────────────────────────────────

/** Parse projects.member_project_ids (JSON id array) defensively. */
function parseMemberProjectIds(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  } catch {
    return []
  }
}

/**
 * The worktree ids a connection project's base instance is made of: the active
 * default worktree of every member project that still exists.
 */
export function resolveBaseInstanceWorktreeIds(db: DatabaseService, project: Project): string[] {
  const ids: string[] = []
  for (const memberId of parseMemberProjectIds(project.member_project_ids)) {
    const defaultWorktree = db
      .getWorktreesByProject(memberId)
      .find((w) => w.is_default && w.status === 'active')
    if (defaultWorktree) ids.push(defaultWorktree.id)
  }
  return ids
}

function sameWorktreeSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * Ensure a connection project has its base instance (connections.is_base = 1)
 * over the member projects' CURRENT default worktrees:
 * - an existing base whose member set still matches is returned as-is;
 * - a stale base (a member project was removed, a default worktree changed) is
 *   demoted to an ordinary instance — deletable again — and replaced;
 * - an instance of the project that already spans exactly the default worktrees
 *   (typically the saved source connection) is promoted instead of duplicated;
 * - otherwise a new base connection is created.
 * Returns null (after logging) when fewer than two member default worktrees
 * resolve — the project is degenerate and has no base.
 */
export async function ensureBaseInstanceForConnectionProjectOp(
  db: DatabaseService,
  project: Project
): Promise<ConnectionWithMembers | null> {
  if (project.kind !== 'connection') return null
  try {
    const worktreeIds = resolveBaseInstanceWorktreeIds(db, project)
    const existing = db.getBaseConnectionForProject(project.id)
    if (existing) {
      const memberIds = existing.members.map((m) => m.worktree_id)
      if (worktreeIds.length >= 2 && sameWorktreeSet(memberIds, worktreeIds)) return existing
      // Stale: keep the row (it may host sessions) but release the lock.
      db.updateConnection(existing.id, { is_base: 0 })
      log.warn('Demoted stale connection project base instance', {
        projectId: project.id,
        connectionId: existing.id,
        members: memberIds.length,
        expected: worktreeIds.length
      })
    }

    if (worktreeIds.length < 2) {
      log.warn('Connection project has fewer than 2 member default worktrees; skipping base', {
        projectId: project.id,
        resolved: worktreeIds.length
      })
      return null
    }

    // Promote an instance that already IS the default-worktree set (e.g. a
    // connection over main + main that was saved as a project) — never
    // materialize a byte-identical twin next to it.
    const promotable = db
      .getAllConnections()
      .find(
        (c) =>
          c.saved_project_id === project.id &&
          !c.is_base &&
          sameWorktreeSet(
            c.members.map((m) => m.worktree_id),
            worktreeIds
          )
      )
    if (promotable) {
      db.updateConnection(promotable.id, { is_base: 1 })
      log.info('Promoted existing instance to connection project base', {
        projectId: project.id,
        connectionId: promotable.id
      })
      return db.getConnection(promotable.id)
    }

    const result = await createConnectionOp(db, worktreeIds, project.id, { isBase: true })
    if (!result.success || !result.connection) {
      log.warn('Failed to create connection project base instance', {
        projectId: project.id,
        error: result.error
      })
      return null
    }
    log.info('Created connection project base instance', {
      projectId: project.id,
      connectionId: result.connection.id
    })
    return result.connection
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Ensure base instance failed', { projectId: project.id, error: message })
    return null
  }
}

/**
 * Heal every connection project that lacks a base instance (projects saved
 * before base instances existed, or whose base creation failed). Idempotent and
 * never throws — safe to run on every connection listing.
 */
export async function ensureConnectionProjectBaseInstancesOp(db: DatabaseService): Promise<void> {
  let projects: Project[]
  try {
    // Orphans first: is_base rows whose project is gone must become deletable.
    const repaired = db.clearOrphanedBaseFlags()
    if (repaired > 0) log.warn('Cleared orphaned connection base flags', { count: repaired })
    projects = db.getAllProjects().filter((p) => p.kind === 'connection')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to enumerate connection projects for base healing', { error: message })
    return
  }
  for (const project of projects) {
    await ensureBaseInstanceForConnectionProjectOp(db, project)
  }
}

/**
 * Remove a connection project's base instance (dir + row). Called when the
 * connection project itself is removed — the only path allowed to take the
 * base down. Must run BEFORE the project row is deleted (the FK nulls
 * saved_project_id on cascade, which would orphan an undeletable row).
 */
export async function deleteBaseInstanceForProjectOp(
  db: DatabaseService,
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  let baseId: string | null = null
  try {
    const base = db.getBaseConnectionForProject(projectId)
    if (!base) return { success: true }
    baseId = base.id
    const result = await deleteConnectionOp(db, base.id, { force: true })
    if (!result.success) {
      // Never leave a locked row behind: demote so it degrades to an ordinary
      // connection once the FK nulls its saved_project_id.
      db.updateConnection(base.id, { is_base: 0 })
      log.warn('Base instance deletion failed; demoted instead', {
        projectId,
        connectionId: base.id,
        error: result.error
      })
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (baseId) {
      try {
        db.updateConnection(baseId, { is_base: 0 })
      } catch {
        // Best-effort demotion only.
      }
    }
    log.warn('Failed to delete connection project base instance', { projectId, error: message })
    return { success: false, error: message }
  }
}

// ── A member project that moved on disk ───────────────────────────────

/** A folder of member links, and how to name it in a sentence. */
interface ConnectionFolder {
  readonly path: string
  readonly label: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function connectionFolder(connection: ConnectionWithMembers): ConnectionFolder {
  return {
    path: connection.path,
    label: `the connection "${connection.custom_name || connection.name}"`
  }
}

function connectionProjectFolder(project: Project): ConnectionFolder {
  return { path: project.path, label: `the connection project "${project.name}"` }
}

/**
 * The folders of links that point into a project: every connection that has one of the
 * project's worktrees as a member, and every connection project that lists the project as a
 * member. Members are matched by worktree and project id, never by path: this is read after
 * the project moved, when its rows already hold the new paths while the links still hold the
 * old ones.
 */
function findConnectionFoldersOfProject(
  db: DatabaseService,
  projectId: string
): { connections: ConnectionWithMembers[]; connectionProjects: Project[] } {
  const connectionIds = new Set<string>()
  for (const worktree of db.getWorktreesByProject(projectId)) {
    for (const membership of db.getConnectionMembersByWorktree(worktree.id)) {
      connectionIds.add(membership.connection_id)
    }
  }
  const connections: ConnectionWithMembers[] = []
  for (const id of connectionIds) {
    const connection = db.getConnection(id)
    if (connection) connections.push(connection)
  }
  const connectionProjects = db
    .getAllProjects()
    .filter(
      (project) =>
        project.kind === 'connection' &&
        parseMemberProjectIds(project.member_project_ids).includes(projectId)
    )
  return { connections, connectionProjects }
}

/**
 * Where a path that names a moved directory, or something inside one, is now; null when it
 * names neither. Whole path segments are compared, so `/dev/app-2` is not inside `/dev/app`.
 * When several old spellings match, the longest one (the most specific directory) wins.
 */
function swapRelocatedPath(path: string, relocations: readonly RelocationMove[]): string | null {
  let best: { from: string; to: string } | null = null
  for (const relocation of relocations) {
    for (const spelling of relocation.from) {
      const from = spelling.length > 1 && spelling.endsWith(sep) ? spelling.slice(0, -1) : spelling
      if (!from) continue
      if (path !== from && !path.startsWith(from + sep)) continue
      if (!best || from.length > best.from.length) best = { from, to: relocation.to }
    }
  }
  return best ? best.to + path.slice(best.from.length) : null
}

/**
 * Replace the symlink at `linkPath` (which points at `previousTarget`) by one to `target`.
 * Removes nothing but a symlink: the entry is checked again right before it is unlinked. When
 * the new link cannot be made the old one is put back, so the folder keeps the entry. Returns
 * null when the link was replaced, otherwise a sentence that says what the link is now.
 */
function replaceSymlink(
  linkPath: string,
  previousTarget: string,
  target: string,
  label: string
): string | null {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return `${linkPath} in ${label} is no longer a link, so it was left as it is.`
    }
    unlinkSync(linkPath)
  } catch (error) {
    return `The link ${linkPath} of ${label} still points at ${previousTarget}, where the project no longer is: ${errorText(error)}`
  }
  try {
    createSymlink(target, linkPath)
    return null
  } catch (error) {
    try {
      createSymlink(previousTarget, linkPath)
    } catch {
      return `The link ${linkPath} of ${label} could not be made again and is now missing (it should point at ${target}): ${errorText(error)}`
    }
    return `The link ${linkPath} of ${label} still points at ${previousTarget}, where the project no longer is: ${errorText(error)}`
  }
}

/**
 * Repoint the links of connection folders at a project that has just moved on disk.
 *
 * A connection folder holds one symlink per member. The name of a link does not say whose it
 * is: the link names of a connection project are derived from the member names at the time
 * each link was made and are stored nowhere, so they stop matching once a member is renamed.
 * Links are therefore found by what they point at. In every folder that has the project as a
 * member, each symlink whose target is one of the old spellings of a moved directory, or lies
 * under one, is replaced by a link of the same name to the same place under the new directory.
 * Nothing but a symlink is ever removed, and a link that points anywhere else is left alone,
 * so running this a second time changes nothing.
 *
 * Synchronous, so the caller can run it in the same tick that repointed the project's rows:
 * neither an agent nor a board scan then finds a dangling link. Never throws: what could not
 * be done comes back as sentences.
 */
export function relinkConnectionSymlinksForMovedProject(
  db: DatabaseService,
  projectId: string,
  relocations: readonly RelocationMove[]
): { relinked: number; warnings: string[] } {
  const warnings: string[] = []
  let relinked = 0
  try {
    let folders: ConnectionFolder[]
    try {
      const found = findConnectionFoldersOfProject(db, projectId)
      folders = [
        ...found.connections.map(connectionFolder),
        ...found.connectionProjects.map(connectionProjectFolder)
      ]
    } catch (error) {
      return {
        relinked,
        warnings: [
          `Could not look up the connections that include this project, so their links still point at its old folder: ${errorText(error)}`
        ]
      }
    }

    for (const folder of folders) {
      let names: string[]
      try {
        names = readdirSync(folder.path)
      } catch (error) {
        // A folder that is gone has no links to repoint.
        if (!isNotFoundError(error)) {
          warnings.push(
            `Could not read the folder of ${folder.label} (${folder.path}), so its links were not checked: ${errorText(error)}`
          )
        }
        continue
      }

      for (const name of names) {
        const linkPath = join(folder.path, name)
        let target: string
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue
          target = readlinkSync(linkPath)
        } catch (error) {
          // Removed since the folder was listed: nothing to repoint.
          if (!isNotFoundError(error)) {
            warnings.push(
              `Could not read the link ${linkPath} of ${folder.label}, so it was not checked: ${errorText(error)}`
            )
          }
          continue
        }

        const swapped = swapRelocatedPath(target, relocations)
        if (swapped === null || swapped === target) continue
        const problem = replaceSymlink(linkPath, target, swapped, folder.label)
        if (problem) warnings.push(problem)
        else relinked++
      }
    }
  } catch (error) {
    warnings.push(`Could not update the links of this project's connections: ${errorText(error)}`)
  }

  if (relinked > 0 || warnings.length > 0) {
    log.info('Relinked connection folders of a moved project', {
      projectId,
      relinked,
      warnings: warnings.length
    })
  }
  return { relinked, warnings }
}

/**
 * The name each link target has in a folder of links. A target that several links point at
 * lists their names in alphabetical order. Empty when the folder cannot be read.
 */
function readLinkNamesByTarget(folderPath: string): Map<string, string[]> {
  const namesByTarget = new Map<string, string[]>()
  let names: string[]
  try {
    names = readdirSync(folderPath).sort()
  } catch {
    return namesByTarget
  }
  for (const name of names) {
    try {
      const linkPath = join(folderPath, name)
      if (!lstatSync(linkPath).isSymbolicLink()) continue
      const target = readlinkSync(linkPath)
      namesByTarget.set(target, [...(namesByTarget.get(target) ?? []), name])
    } catch {
      // Not a link that can be read: it names no member.
    }
  }
  return namesByTarget
}

/**
 * The members a connection project's AGENTS.md / CLAUDE.md should list. The derived link name
 * of a member is only what its link was called if the member has not been renamed since, so
 * the name of the link that really points at the member's folder is used when there is one.
 */
function connectionProjectInstructionMembers(
  db: DatabaseService,
  project: Project
): ConnectionProjectAgentsMdMember[] {
  const namesByTarget = readLinkNamesByTarget(project.path)
  return buildConnectionProjectAgentsMdMembers(
    db,
    parseMemberProjectIds(project.member_project_ids)
  ).map((member) => {
    const onDisk = namesByTarget.get(member.worktreePath) ?? []
    if (onDisk.length === 0 || onDisk.includes(member.symlinkName)) return member
    return { ...member, symlinkName: onDisk[0] }
  })
}

/**
 * Write AGENTS.md and CLAUDE.md again in every connection folder that has the project as a
 * member (the folders `relinkConnectionSymlinksForMovedProject` visits), so that the real
 * paths they list are the ones the database holds now. A folder that is no longer on disk is
 * skipped. Never throws: each folder that could not be written comes back as a sentence. Safe
 * to run twice.
 */
export function regenerateConnectionInstructionsForProject(
  db: DatabaseService,
  projectId: string
): string[] {
  const warnings: string[] = []
  const regenerate = (
    folder: ConnectionFolder,
    members: () => Parameters<typeof generateConnectionInstructions>[1]
  ): void => {
    try {
      if (!existsSync(folder.path)) return
      generateConnectionInstructions(folder.path, members())
    } catch (error) {
      warnings.push(
        `Could not rewrite AGENTS.md and CLAUDE.md of ${folder.label} (${folder.path}), so they still name the project's old folder: ${errorText(error)}`
      )
    }
  }

  try {
    const found = findConnectionFoldersOfProject(db, projectId)
    for (const connection of found.connections) {
      regenerate(connectionFolder(connection), () => buildAgentsMdMembers(connection))
    }
    for (const project of found.connectionProjects) {
      regenerate(connectionProjectFolder(project), () =>
        connectionProjectInstructionMembers(db, project)
      )
    }
  } catch (error) {
    warnings.push(
      `Could not look up the connections that include this project, so their AGENTS.md and CLAUDE.md still name its old folder: ${errorText(error)}`
    )
  }
  return warnings
}
