import { Effect } from 'effect'
import { z } from 'zod'
import { getDatabase } from '../../../main/db'
import {
  addConnectionMemberOp,
  createConnectionOp,
  deleteConnectionOp,
  getAllConnectionsOp,
  getConnectionOp,
  getPinnedConnectionsOp,
  removeConnectionMemberOp,
  removeWorktreeFromAllConnectionsOp,
  renameConnectionOp,
  setConnectionPinnedOp
} from '../../../main/services/connection-ops'
import { telemetryService } from '../../../main/services/telemetry-service'
import type { ConnectionWithMembers } from '../../../shared/types/connection'
import type { RpcHandler } from '../router'

export interface ConnectionOpsCreateResult {
  readonly success: boolean
  readonly connection?: ConnectionWithMembers
  readonly error?: string
}

export interface ConnectionOpsGetAllResult {
  readonly success: boolean
  readonly connections?: ConnectionWithMembers[]
  readonly error?: string
}

export interface ConnectionOpsGetResult {
  readonly success: boolean
  readonly connection?: ConnectionWithMembers
  readonly error?: string
}

export interface ConnectionOpsDeleteResult {
  readonly success: boolean
  readonly error?: string
}

export interface ConnectionOpsAddMemberResult {
  readonly success: boolean
  readonly member?: ConnectionWithMembers['members'][0]
  readonly error?: string
}

export interface ConnectionOpsRemoveMemberResult {
  readonly success: boolean
  readonly connectionDeleted?: boolean
  readonly error?: string
}

export interface ConnectionOpsOpenInTerminalResult {
  readonly success: boolean
  readonly error?: string
}

export interface ConnectionOpsOpenInEditorResult {
  readonly success: boolean
  readonly error?: string
}

export interface ConnectionOpsRemoveWorktreeFromAllResult {
  readonly success: boolean
  readonly error?: string
}

export interface ConnectionOpsRenameResult {
  readonly success: boolean
  readonly connection?: ConnectionWithMembers
  readonly error?: string
}

export interface ConnectionOpsSetPinnedResult {
  readonly success: boolean
  readonly error?: string
}

export interface ConnectionOpsRpcService {
  readonly create: (
    worktreeIds: string[]
  ) => Effect.Effect<ConnectionOpsCreateResult, unknown, never>
  readonly addMember: (
    connectionId: string,
    worktreeId: string
  ) => Effect.Effect<ConnectionOpsAddMemberResult, unknown, never>
  readonly removeMember: (
    connectionId: string,
    worktreeId: string
  ) => Effect.Effect<ConnectionOpsRemoveMemberResult, unknown, never>
  readonly openInTerminal: (
    connectionPath: string
  ) => Effect.Effect<ConnectionOpsOpenInTerminalResult, unknown, never>
  readonly openInEditor: (
    connectionPath: string
  ) => Effect.Effect<ConnectionOpsOpenInEditorResult, unknown, never>
  readonly removeWorktreeFromAll: (
    worktreeId: string
  ) => Effect.Effect<ConnectionOpsRemoveWorktreeFromAllResult, unknown, never>
  readonly rename: (
    connectionId: string,
    customName: string | null
  ) => Effect.Effect<ConnectionOpsRenameResult, unknown, never>
  readonly setPinned: (
    connectionId: string,
    pinned: boolean
  ) => Effect.Effect<ConnectionOpsSetPinnedResult, unknown, never>
  readonly getPinned: () => Effect.Effect<ConnectionWithMembers[], unknown, never>
  readonly getAll: () => Effect.Effect<ConnectionOpsGetAllResult, unknown, never>
  readonly get: (connectionId: string) => Effect.Effect<ConnectionOpsGetResult, unknown, never>
  readonly delete: (
    connectionId: string
  ) => Effect.Effect<ConnectionOpsDeleteResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const createParamsSchema = z.object({ worktreeIds: z.array(z.string().min(1)) }).strict()
const connectionIdParamsSchema = z.object({ connectionId: z.string().min(1) }).strict()
const connectionPathParamsSchema = z.object({ connectionPath: z.string().min(1) }).strict()
const worktreeIdParamsSchema = z.object({ worktreeId: z.string().min(1) }).strict()
const renameParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    customName: z.string().nullable()
  })
  .strict()
const setPinnedParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    pinned: z.boolean()
  })
  .strict()
const connectionMemberParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    worktreeId: z.string().min(1)
  })
  .strict()

export const makeLiveConnectionOpsRpcService = (): ConnectionOpsRpcService => ({
  create: (worktreeIds) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        const result = await createConnectionOp(db, worktreeIds)
        if (result.success) {
          telemetryService.track('connection_created')
        }
        return result
      },
      catch: (cause) => cause
    }),
  addMember: (connectionId, worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return addConnectionMemberOp(db, connectionId, worktreeId)
      },
      catch: (cause) => cause
    }),
  removeMember: (connectionId, worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return removeConnectionMemberOp(db, connectionId, worktreeId)
      },
      catch: (cause) => cause
    }),
  openInTerminal: (connectionPath) =>
    Effect.tryPromise({
      try: async () => {
        const { openPathWithPreferredTerminal } =
          await import('../../../main/services/settings-openers')
        return openPathWithPreferredTerminal(connectionPath)
      },
      catch: (cause) => cause
    }),
  openInEditor: (connectionPath) =>
    Effect.tryPromise({
      try: async () => {
        const { openPathWithPreferredEditor } =
          await import('../../../main/services/settings-openers')
        return openPathWithPreferredEditor(connectionPath)
      },
      catch: (cause) => cause
    }),
  removeWorktreeFromAll: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return removeWorktreeFromAllConnectionsOp(db, worktreeId)
      },
      catch: (cause) => cause
    }),
  rename: (connectionId, customName) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return renameConnectionOp(db, connectionId, customName)
      },
      catch: (cause) => cause
    }),
  setPinned: (connectionId, pinned) =>
    Effect.sync(() => {
      const db = getDatabase()
      return setConnectionPinnedOp(db, connectionId, pinned)
    }),
  getPinned: () =>
    Effect.try({
      try: () => {
        const db = getDatabase()
        return getPinnedConnectionsOp(db)
      },
      catch: (cause) => cause
    }),
  getAll: () =>
    Effect.sync(() => {
      const db = getDatabase()
      return getAllConnectionsOp(db)
    }),
  get: (connectionId) =>
    Effect.sync(() => {
      const db = getDatabase()
      return getConnectionOp(db, connectionId)
    }),
  delete: (connectionId) =>
    Effect.tryPromise({
      try: async () => {
        const db = getDatabase()
        return deleteConnectionOp(db, connectionId)
      },
      catch: (cause) => cause
    })
})

export const makeConnectionOpsRpcHandlers = (
  service: ConnectionOpsRpcService = makeLiveConnectionOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'connectionOps.create',
      (params) =>
        Effect.gen(function* () {
          const { worktreeIds } = yield* Effect.try({
            try: () => createParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.create(worktreeIds)
        })
    ],
    [
      'connectionOps.addMember',
      (params) =>
        Effect.gen(function* () {
          const { connectionId, worktreeId } = yield* Effect.try({
            try: () => connectionMemberParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.addMember(connectionId, worktreeId)
        })
    ],
    [
      'connectionOps.removeMember',
      (params) =>
        Effect.gen(function* () {
          const { connectionId, worktreeId } = yield* Effect.try({
            try: () => connectionMemberParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeMember(connectionId, worktreeId)
        })
    ],
    [
      'connectionOps.openInTerminal',
      (params) =>
        Effect.gen(function* () {
          const { connectionPath } = yield* Effect.try({
            try: () => connectionPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInTerminal(connectionPath)
        })
    ],
    [
      'connectionOps.openInEditor',
      (params) =>
        Effect.gen(function* () {
          const { connectionPath } = yield* Effect.try({
            try: () => connectionPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInEditor(connectionPath)
        })
    ],
    [
      'connectionOps.removeWorktreeFromAll',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeWorktreeFromAll(worktreeId)
        })
    ],
    [
      'connectionOps.rename',
      (params) =>
        Effect.gen(function* () {
          const { connectionId, customName } = yield* Effect.try({
            try: () => renameParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.rename(connectionId, customName)
        })
    ],
    [
      'connectionOps.setPinned',
      (params) =>
        Effect.gen(function* () {
          const { connectionId, pinned } = yield* Effect.try({
            try: () => setPinnedParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setPinned(connectionId, pinned)
        })
    ],
    [
      'connectionOps.getAll',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAll()
        })
    ],
    [
      'connectionOps.getPinned',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPinned()
        })
    ],
    [
      'connectionOps.get',
      (params) =>
        Effect.gen(function* () {
          const { connectionId } = yield* Effect.try({
            try: () => connectionIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.get(connectionId)
        })
    ],
    [
      'connectionOps.delete',
      (params) =>
        Effect.gen(function* () {
          const { connectionId } = yield* Effect.try({
            try: () => connectionIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.delete(connectionId)
        })
    ]
  ])
