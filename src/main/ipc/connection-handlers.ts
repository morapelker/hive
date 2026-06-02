import { Data, Effect } from 'effect'
import { z } from 'zod'

import { openPathWithPreferredEditor, openPathWithPreferredTerminal } from './settings-handlers'
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
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'ConnectionHandlers' })

class ConnectionHandlerFailed extends Data.TaggedError('ConnectionHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const connectionFailed = (operation: string, cause: unknown): ConnectionHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new ConnectionHandlerFailed({ operation, reason, message: reason })
}

const connectionIdSchema = z.object({ connectionId: z.string().min(1) })
const connectionPathSchema = z.object({ connectionPath: z.string().min(1) })
const connectionMemberSchema = z.object({
  connectionId: z.string().min(1),
  worktreeId: z.string().min(1)
})

export function registerConnectionHandlers(): void {
  log.info('Registering connection handlers')

  // Create a new connection from a set of worktree IDs
  defineHandler(
    'connection:create',
    z.object({ worktreeIds: z.array(z.string().min(1)) }),
    ({
      worktreeIds
    }): Effect.Effect<
      {
        success: boolean
        connection?: ConnectionWithMembers
        error?: string
      },
      ConnectionHandlerFailed
    > =>
      Effect.tryPromise({
        try: async () => {
          const db = getDatabase()
          return createConnectionOp(db, worktreeIds)
        },
        catch: (error) => {
          log.error(
            'Create connection failed',
            error instanceof Error ? error : new Error(String(error))
          )
          return connectionFailed('connection:create', error)
        }
      }).pipe(
        Effect.tap((result) =>
          result.success
            ? Effect.sync(() => telemetryService.track('connection_created'))
            : Effect.void
        )
      )
  )

  // Rename a connection (set or clear custom_name)
  defineHandler(
    'connection:rename',
    z.object({ connectionId: z.string().min(1), customName: z.string().nullable() }),
    ({ connectionId, customName }) =>
      Effect.tryPromise({
        try: async () => {
          const db = getDatabase()
          return renameConnectionOp(db, connectionId, customName)
        },
        catch: (error) => connectionFailed('connection:rename', error)
      })
  )

  // Delete a connection (filesystem + DB)
  defineHandler('connection:delete', connectionIdSchema, ({ connectionId }) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return deleteConnectionOp(db, connectionId)
      },
      catch: (error) => connectionFailed('connection:delete', error)
    })
  )

  // Add a member (worktree) to an existing connection
  defineHandler(
    'connection:addMember',
    connectionMemberSchema,
    ({
      connectionId,
      worktreeId
    }): Effect.Effect<
      {
        success: boolean
        member?: ConnectionWithMembers['members'][0]
        error?: string
      },
      ConnectionHandlerFailed
    > =>
      Effect.tryPromise({
        try: async () => {
          const db = getDatabase()
          return addConnectionMemberOp(db, connectionId, worktreeId)
        },
        catch: (error) => connectionFailed('connection:addMember', error)
      })
  )

  // Remove a member from a connection. If last member, delete the entire connection.
  defineHandler('connection:removeMember', connectionMemberSchema, ({ connectionId, worktreeId }) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return removeConnectionMemberOp(db, connectionId, worktreeId)
      },
      catch: (error) => connectionFailed('connection:removeMember', error)
    })
  )

  // Get all active connections with enriched member data
  defineHandler(
    'connection:getAll',
    z.tuple([]),
    (): Effect.Effect<
      {
        success: boolean
        connections?: ConnectionWithMembers[]
        error?: string
      },
      never
    > =>
      Effect.sync(() => {
        try {
          const db = getDatabase()
          const connections = db.getAllConnections()
          return { success: true, connections }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.error(
            'Get all connections failed',
            error instanceof Error ? error : new Error(message)
          )
          return { success: false, error: message }
        }
      })
  )

  // Get a single connection with enriched member data
  defineHandler('connection:get', connectionIdSchema, ({ connectionId }) =>
    Effect.sync(() => {
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
    })
  )

  // Open connection directory in user's preferred terminal (from Settings)
  defineHandler('connection:openInTerminal', connectionPathSchema, ({ connectionPath }) =>
    Effect.tryPromise({
      try: () => openPathWithPreferredTerminal(connectionPath),
      catch: (error) => connectionFailed('connection:openInTerminal', error)
    })
  )

  // Open connection directory in user's preferred editor (from Settings)
  defineHandler('connection:openInEditor', connectionPathSchema, ({ connectionPath }) =>
    Effect.tryPromise({
      try: () => openPathWithPreferredEditor(connectionPath),
      catch: (error) => connectionFailed('connection:openInEditor', error)
    })
  )

  // Pin / unpin a connection
  defineHandler(
    'connection:setPinned',
    z.object({ connectionId: z.string().min(1), pinned: z.boolean() }),
    ({ connectionId, pinned }) =>
      Effect.sync(() => {
        try {
          getDatabase().updateConnection(connectionId, { pinned: pinned ? 1 : 0 })
          return { success: true }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
  )

  // Get all pinned connections with enriched member data
  defineHandler('connection:getPinned', z.tuple([]), () =>
    Effect.try({
      try: () => {
        const db = getDatabase()
        return db.getPinnedConnections()
      },
      catch: (error) => connectionFailed('connection:getPinned', error)
    })
  )

  // Remove a worktree from ALL connections it belongs to.
  // Used by the archive cascade -- when a worktree is archived, clean up its connections.
  defineHandler(
    'connection:removeWorktreeFromAll',
    z.object({ worktreeId: z.string().min(1) }),
    ({ worktreeId }) =>
      Effect.tryPromise({
        try: async () => {
          const db = getDatabase()
          return removeWorktreeFromAllConnectionsOp(db, worktreeId)
        },
        catch: (error) => connectionFailed('connection:removeWorktreeFromAll', error)
      })
  )
}
