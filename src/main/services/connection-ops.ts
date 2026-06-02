import { randomUUID } from 'crypto'
import { join } from 'path'
import { createLogger } from './logger'
import {
  createConnectionDir,
  createSymlink,
  removeSymlink,
  deleteConnectionDir,
  generateConnectionInstructions,
  deriveSymlinkName,
  generateConnectionColor
} from './connection-service'
import type { DatabaseService } from '../db/database'
import type { ConnectionWithMembers } from '../db/types'

const log = createLogger({ component: 'ConnectionOps' })

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

/**
 * Create a new connection from a set of worktree IDs.
 * Creates the filesystem directory, DB record, symlinks, members, derives the name,
 * and generates AGENTS.md instructions.
 */
export async function createConnectionOp(
  db: DatabaseService,
  worktreeIds: string[]
): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> {
  log.info('Creating connection', { worktreeCount: worktreeIds.length })
  try {
    // Use a short random ID for the directory name (avoids filesystem issues with special chars)
    const dirName = randomUUID().slice(0, 8)
    const dirPath = createConnectionDir(dirName)

    // Create the DB connection record with placeholder name and random color
    const color = generateConnectionColor()
    const connection = db.createConnection({ name: dirName, path: dirPath, color })

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

/**
 * Delete a connection (filesystem directory + DB record).
 */
export async function deleteConnectionOp(
  db: DatabaseService,
  connectionId: string
): Promise<{ success: boolean; error?: string }> {
  log.info('Deleting connection', { connectionId })
  try {
    const connection = db.getConnection(connectionId)
    if (!connection) {
      return { success: false, error: 'Connection not found' }
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
