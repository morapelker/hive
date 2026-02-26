import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { createLogger } from '../services'
import { telemetryService } from '../services/telemetry-service'
import {
  createConnectionOp,
  deleteConnectionOp,
  renameConnectionOp,
  addConnectionMemberOp,
  removeConnectionMemberOp,
  removeWorktreeFromAllConnectionsOp
} from '../services/connection-ops'
import { getDatabase } from '../db'
import type { ConnectionWithMembers } from '../db/types'

const log = createLogger({ component: 'ConnectionHandlers' })

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
      const db = getDatabase()
      const result = createConnectionOp(db, worktreeIds)
      if (result.success) {
        telemetryService.track('connection_created')
      }
      return result
    }
  )

  // Rename a connection (set or clear custom_name)
  ipcMain.handle(
    'connection:rename',
    async (
      _event,
      { connectionId, customName }: { connectionId: string; customName: string | null }
    ): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> => {
      const db = getDatabase()
      return renameConnectionOp(db, connectionId, customName)
    }
  )

  // Delete a connection (filesystem + DB)
  ipcMain.handle(
    'connection:delete',
    async (
      _event,
      { connectionId }: { connectionId: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const db = getDatabase()
      return deleteConnectionOp(db, connectionId)
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
      const db = getDatabase()
      return addConnectionMemberOp(db, connectionId, worktreeId)
    }
  )

  // Remove a member from a connection. If last member, delete the entire connection.
  ipcMain.handle(
    'connection:removeMember',
    async (
      _event,
      { connectionId, worktreeId }: { connectionId: string; worktreeId: string }
    ): Promise<{ success: boolean; connectionDeleted?: boolean; error?: string }> => {
      const db = getDatabase()
      return removeConnectionMemberOp(db, connectionId, worktreeId)
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

  // Pin / unpin a connection
  ipcMain.handle(
    'connection:setPinned',
    (
      _event,
      { connectionId, pinned }: { connectionId: string; pinned: boolean }
    ): { success: boolean; error?: string } => {
      try {
        getDatabase().updateConnection(connectionId, { pinned: pinned ? 1 : 0 })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // Get all pinned connections with enriched member data
  ipcMain.handle('connection:getPinned', () => {
    const db = getDatabase()
    return db.getPinnedConnections()
  })

  // Remove a worktree from ALL connections it belongs to.
  // Used by the archive cascade -- when a worktree is archived, clean up its connections.
  ipcMain.handle(
    'connection:removeWorktreeFromAll',
    async (
      _event,
      { worktreeId }: { worktreeId: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const db = getDatabase()
      return removeWorktreeFromAllConnectionsOp(db, worktreeId)
    }
  )
}
