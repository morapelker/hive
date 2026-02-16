import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'
import { createLogger } from '../services'
import { selectUniqueBreedName, type BreedType } from '../services/breed-names'
import {
  createConnectionDir,
  createSymlink,
  removeSymlink,
  deleteConnectionDir,
  generateAgentsMd,
  deriveSymlinkName,
  renameConnectionDir,
  getConnectionsBaseDir
} from '../services/connection-service'
import { getDatabase } from '../db'
import type { ConnectionWithMembers } from '../db/types'

const log = createLogger({ component: 'ConnectionHandlers' })

/**
 * Read the breed type preference from app settings.
 */
function getBreedType(): BreedType {
  try {
    const settingsJson = getDatabase().getSetting('app_settings')
    if (settingsJson) {
      const settings = JSON.parse(settingsJson)
      if (settings.breedType === 'cats') return 'cats'
    }
  } catch {
    // Fall back to dogs
  }
  return 'dogs'
}

/**
 * Build the AgentsMdMember array from the enriched connection data.
 */
function buildAgentsMdMembers(
  connection: ConnectionWithMembers
): { symlinkName: string; projectName: string; branchName: string; worktreePath: string }[] {
  return connection.members.map((m) => ({
    symlinkName: m.symlink_name,
    projectName: m.project_name,
    branchName: m.worktree_branch,
    worktreePath: m.worktree_path
  }))
}

export function registerConnectionHandlers(): void {
  log.info('Registering connection handlers')

  // Create a new connection from a set of worktree IDs
  ipcMain.handle(
    'connection:create',
    async (
      _event,
      { worktreeIds }: { worktreeIds: string[] }
    ): Promise<{
      success: boolean
      connection?: ConnectionWithMembers
      error?: string
    }> => {
      log.info('Creating connection', { worktreeCount: worktreeIds.length })
      try {
        const db = getDatabase()

        // Generate a unique breed name for the connection
        const existingConnections = db.getAllConnections()
        const existingNames = new Set(existingConnections.map((c) => c.name))
        const breedType = getBreedType()
        const name = selectUniqueBreedName(existingNames, breedType)

        // Create the filesystem directory
        const dirPath = createConnectionDir(name)

        // Create the DB connection record
        const connection = db.createConnection({ name, path: dirPath })

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

        // Fetch the enriched connection (with joined member data)
        const enriched = db.getConnection(connection.id)
        if (enriched) {
          generateAgentsMd(dirPath, buildAgentsMdMembers(enriched))
        }

        log.info('Connection created', { id: connection.id, name, memberCount: worktreeIds.length })
        return { success: true, connection: enriched ?? undefined }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Connection creation failed', error instanceof Error ? error : new Error(message))
        return { success: false, error: message }
      }
    }
  )

  // Delete a connection (filesystem + DB)
  ipcMain.handle(
    'connection:delete',
    async (
      _event,
      { connectionId }: { connectionId: string }
    ): Promise<{ success: boolean; error?: string }> => {
      log.info('Deleting connection', { connectionId })
      try {
        const db = getDatabase()
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
  )

  // Add a member (worktree) to an existing connection
  ipcMain.handle(
    'connection:addMember',
    async (
      _event,
      { connectionId, worktreeId }: { connectionId: string; worktreeId: string }
    ): Promise<{
      success: boolean
      member?: ConnectionWithMembers['members'][0]
      error?: string
    }> => {
      log.info('Adding member to connection', { connectionId, worktreeId })
      try {
        const db = getDatabase()
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

        // Regenerate AGENTS.md with the updated member list
        const updated = db.getConnection(connectionId)
        if (updated) {
          generateAgentsMd(updated.path, buildAgentsMdMembers(updated))
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
  )

  // Remove a member from a connection. If last member, delete the entire connection.
  ipcMain.handle(
    'connection:removeMember',
    async (
      _event,
      { connectionId, worktreeId }: { connectionId: string; worktreeId: string }
    ): Promise<{ success: boolean; connectionDeleted?: boolean; error?: string }> => {
      log.info('Removing member from connection', { connectionId, worktreeId })
      try {
        const db = getDatabase()
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

        // Regenerate AGENTS.md with remaining members
        generateAgentsMd(remaining.path, buildAgentsMdMembers(remaining))

        log.info('Member removed from connection', { connectionId, worktreeId })
        return { success: true, connectionDeleted: false }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Remove member failed', error instanceof Error ? error : new Error(message))
        return { success: false, error: message }
      }
    }
  )

  // Rename a connection (folder on disk + DB record)
  ipcMain.handle(
    'connection:rename',
    async (
      _event,
      { connectionId, name }: { connectionId: string; name: string }
    ): Promise<{ success: boolean; error?: string }> => {
      log.info('Renaming connection', { connectionId, name })
      try {
        const db = getDatabase()
        const connection = db.getConnection(connectionId)
        if (!connection) {
          return { success: false, error: 'Connection not found' }
        }

        // Compute the new path
        const newPath = join(getConnectionsBaseDir(), name)

        // Rename the directory on disk
        renameConnectionDir(connection.path, newPath)

        // Update DB with new name and path
        db.updateConnection(connectionId, { name, path: newPath })

        log.info('Connection renamed', {
          connectionId,
          oldName: connection.name,
          newName: name
        })
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Connection rename failed', error instanceof Error ? error : new Error(message))
        return { success: false, error: message }
      }
    }
  )

  // Get all active connections with enriched member data
  ipcMain.handle(
    'connection:getAll',
    async (): Promise<{
      success: boolean
      connections?: ConnectionWithMembers[]
      error?: string
    }> => {
      try {
        const db = getDatabase()
        const connections = db.getAllConnections()
        return { success: true, connections }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Get all connections failed', error instanceof Error ? error : new Error(message))
        return { success: false, error: message }
      }
    }
  )

  // Get a single connection with enriched member data
  ipcMain.handle(
    'connection:get',
    async (
      _event,
      { connectionId }: { connectionId: string }
    ): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> => {
      try {
        const db = getDatabase()
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
  )

  // Open connection directory in terminal
  ipcMain.handle(
    'connection:openInTerminal',
    async (
      _event,
      { connectionPath }: { connectionPath: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!existsSync(connectionPath)) {
          return { success: false, error: 'Connection directory does not exist' }
        }

        const currentPlatform = platform()

        if (currentPlatform === 'darwin') {
          spawn('open', ['-a', 'Terminal', connectionPath], { detached: true })
        } else if (currentPlatform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${connectionPath}"`], {
            detached: true,
            shell: true
          })
        } else {
          const terminals = [
            'gnome-terminal',
            'konsole',
            'xfce4-terminal',
            'xterm',
            'terminator',
            'alacritty',
            'kitty'
          ]
          let launched = false
          for (const terminal of terminals) {
            try {
              if (terminal === 'gnome-terminal') {
                spawn(terminal, ['--working-directory', connectionPath], { detached: true })
              } else {
                spawn(terminal, [], { cwd: connectionPath, detached: true })
              }
              launched = true
              break
            } catch {
              // Try next terminal
            }
          }
          if (!launched) {
            return { success: false, error: 'No supported terminal emulator found' }
          }
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }
  )

  // Open connection directory in editor (VS Code)
  ipcMain.handle(
    'connection:openInEditor',
    async (
      _event,
      { connectionPath }: { connectionPath: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!existsSync(connectionPath)) {
          return { success: false, error: 'Connection directory does not exist' }
        }

        const currentPlatform = platform()

        const vsCodeCommands =
          currentPlatform === 'darwin'
            ? [
                '/usr/local/bin/code',
                '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
              ]
            : currentPlatform === 'win32'
              ? ['code.cmd', 'code']
              : ['code']

        let launched = false
        for (const codeCmd of vsCodeCommands) {
          try {
            spawn(codeCmd, [connectionPath], { detached: true, stdio: 'ignore' })
            launched = true
            break
          } catch {
            // Try next command
          }
        }

        if (!launched) {
          await shell.openPath(connectionPath)
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }
  )

  // Remove a worktree from ALL connections it belongs to.
  // Used by the archive cascade -- when a worktree is archived, clean up its connections.
  ipcMain.handle(
    'connection:removeWorktreeFromAll',
    async (
      _event,
      { worktreeId }: { worktreeId: string }
    ): Promise<{ success: boolean; error?: string }> => {
      log.info('Removing worktree from all connections', { worktreeId })
      try {
        const db = getDatabase()
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
            // Regenerate AGENTS.md for remaining members
            generateAgentsMd(remaining.path, buildAgentsMdMembers(remaining))
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
  )
}
