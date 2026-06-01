import { existsSync } from 'node:fs'
import { Effect } from 'effect'
import { z } from 'zod'
import type {
  CreateFromBranchParams,
  CreateWorktreeParams,
  DeleteWorktreeParams,
  DuplicateWorktreeParams,
  RenameBranchParams,
  SimpleResult,
  SyncWorktreesParams,
  WorktreeResult
} from '../../../main/services/worktree-ops'
import type { RpcHandler } from '../router'

export interface WorktreeOpsRpcService {
  readonly hasCommits: (projectPath: string) => Effect.Effect<boolean, unknown, never>
  readonly create: (params: CreateWorktreeParams) => Effect.Effect<WorktreeResult, unknown, never>
  readonly delete: (params: DeleteWorktreeParams) => Effect.Effect<SimpleResult, unknown, never>
  readonly sync: (params: SyncWorktreesParams) => Effect.Effect<SimpleResult, unknown, never>
  readonly duplicate: (
    params: DuplicateWorktreeParams
  ) => Effect.Effect<WorktreeResult, unknown, never>
  readonly renameBranch: (params: RenameBranchParams) => Effect.Effect<SimpleResult, unknown, never>
  readonly createFromBranch: (
    params: CreateFromBranchParams
  ) => Effect.Effect<WorktreeResult, unknown, never>
  readonly exists: (worktreePath: string) => Effect.Effect<boolean, unknown, never>
  readonly openInTerminal: (worktreePath: string) => Effect.Effect<SimpleResult, unknown, never>
  readonly openInEditor: (worktreePath: string) => Effect.Effect<SimpleResult, unknown, never>
  readonly getBranches: (projectPath: string) => Effect.Effect<BranchesResult, unknown, never>
  readonly branchExists: (
    projectPath: string,
    branchName: string
  ) => Effect.Effect<boolean, unknown, never>
  readonly getContext?: (worktreeId: string) => Effect.Effect<WorktreeContextResult, unknown, never>
  readonly updateContext?: (
    worktreeId: string,
    context: string | null
  ) => Effect.Effect<SimpleResult, unknown, never>
}

export interface BranchesResult {
  readonly success: boolean
  readonly branches?: string[]
  readonly currentBranch?: string
  readonly error?: string
}

export interface WorktreeContextResult {
  readonly success: boolean
  readonly context?: string | null
  readonly error?: string
}

const projectPathParamsSchema = z.object({ projectPath: z.string().min(1) }).strict()
const worktreeIdParamsSchema = z.object({ worktreeId: z.string().min(1) }).strict()
const updateContextParamsSchema = z
  .object({ worktreeId: z.string().min(1), context: z.string().nullable() })
  .strict()
const branchExistsParamsSchema = z
  .object({ projectPath: z.string().min(1), branchName: z.string().min(1) })
  .strict()
const worktreePathParamsSchema = z.object({ worktreePath: z.string().min(1) }).strict()
const createWorktreeParamsSchema = z
  .object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    projectName: z.string().min(1)
  })
  .strict() satisfies z.ZodType<CreateWorktreeParams>
const deleteWorktreeParamsSchema = z
  .object({
    worktreeId: z.string().min(1),
    worktreePath: z.string().min(1),
    branchName: z.string().min(1),
    projectPath: z.string().min(1),
    archive: z.boolean()
  })
  .strict() satisfies z.ZodType<DeleteWorktreeParams>
const syncWorktreesParamsSchema = z
  .object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1)
  })
  .strict() satisfies z.ZodType<SyncWorktreesParams>
const duplicateWorktreeParamsSchema = z
  .object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    projectName: z.string().min(1),
    sourceBranch: z.string().min(1),
    sourceWorktreePath: z.string().min(1),
    nameHint: z.string().optional()
  })
  .strict() satisfies z.ZodType<DuplicateWorktreeParams>
const renameBranchParamsSchema = z
  .object({
    worktreeId: z.string().min(1),
    worktreePath: z.string().min(1),
    oldBranch: z.string().min(1),
    newBranch: z.string().min(1)
  })
  .strict() satisfies z.ZodType<RenameBranchParams>
const createFromBranchParamsSchema = z
  .object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    projectName: z.string().min(1),
    branchName: z.string().min(1),
    prNumber: z.number().optional(),
    nameHint: z.string().optional()
  })
  .strict() satisfies z.ZodType<CreateFromBranchParams>

export const makeLiveWorktreeOpsRpcService = (): WorktreeOpsRpcService => ({
  hasCommits: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { gitService } = await import('../../../main/effect/git/facade')
        return gitService.hasCommits(projectPath)
      },
      catch: (cause) => cause
    }).pipe(Effect.catchAll(() => Effect.succeed(false))),
  create: (params) =>
    Effect.tryPromise({
      try: async () => {
        const [{ worktreeOpsFacade }, { telemetryService }] = await Promise.all([
          import('../../../main/effect/db/facade'),
          import('../../../main/services/telemetry-service')
        ])
        const result = await worktreeOpsFacade.create(params)
        if (result.success) {
          telemetryService.track('worktree_created')
        }
        return result
      },
      catch: (cause) => cause
    }),
  delete: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreeOpsFacade } = await import('../../../main/effect/db/facade')
        return worktreeOpsFacade.delete(params)
      },
      catch: (cause) => cause
    }),
  sync: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreeOpsFacade } = await import('../../../main/effect/db/facade')
        return worktreeOpsFacade.sync(params)
      },
      catch: (cause) => cause
    }),
  duplicate: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreeOpsFacade } = await import('../../../main/effect/db/facade')
        return worktreeOpsFacade.duplicate(params)
      },
      catch: (cause) => cause
    }),
  renameBranch: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreeOpsFacade } = await import('../../../main/effect/db/facade')
        return worktreeOpsFacade.renameBranch(params)
      },
      catch: (cause) => cause
    }),
  createFromBranch: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreeOpsFacade } = await import('../../../main/effect/db/facade')
        return worktreeOpsFacade.createFromBranch(params)
      },
      catch: (cause) => cause
    }),
  exists: (worktreePath) =>
    Effect.try({
      try: () => existsSync(worktreePath),
      catch: (cause) => cause
    }),
  openInTerminal: (worktreePath) =>
    Effect.tryPromise({
      try: async () => {
        const { openPathWithPreferredTerminal } =
          await import('../../../main/services/settings-openers')
        return openPathWithPreferredTerminal(worktreePath)
      },
      catch: (cause) => cause
    }),
  openInEditor: (worktreePath) =>
    Effect.tryPromise({
      try: async () => {
        const { openPathWithPreferredEditor } =
          await import('../../../main/services/settings-openers')
        return openPathWithPreferredEditor(worktreePath)
      },
      catch: (cause) => cause
    }),
  getBranches: (projectPath) =>
    Effect.tryPromise({
      try: async (): Promise<BranchesResult> => {
        try {
          const { createGitService } = await import('../../../main/services/git-service')
          const gitService = createGitService(projectPath)
          const branches = await gitService.getAllBranches()
          const currentBranch = await gitService.getCurrentBranch()

          return {
            success: true,
            branches,
            currentBranch
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      },
      catch: (cause) => cause
    }),
  branchExists: (projectPath, branchName) =>
    Effect.tryPromise({
      try: async (): Promise<boolean> => {
        try {
          const { createGitService } = await import('../../../main/services/git-service')
          const gitService = createGitService(projectPath)
          return await gitService.branchExists(branchName)
        } catch {
          return false
        }
      },
      catch: (cause) => cause
    }),
  getContext: (worktreeId) =>
    Effect.tryPromise({
      try: async (): Promise<WorktreeContextResult> => {
        try {
          const { getDatabase } = await import('../../../main/db')
          const worktree = getDatabase().getWorktree(worktreeId)
          if (!worktree) return { success: false, error: 'Worktree not found' }
          return { success: true, context: worktree.context }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      },
      catch: (cause) => cause
    }),
  updateContext: (worktreeId, context) =>
    Effect.tryPromise({
      try: async (): Promise<SimpleResult> => {
        try {
          const { getDatabase } = await import('../../../main/db')
          getDatabase().updateWorktreeContext(worktreeId, context)
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      },
      catch: (cause) => cause
    })
})

export const makeWorktreeOpsRpcHandlers = (
  service: WorktreeOpsRpcService = makeLiveWorktreeOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'worktreeOps.hasCommits',
      (params) =>
        Effect.gen(function* () {
          const { projectPath } = yield* Effect.try({
            try: () => projectPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.hasCommits(projectPath)
        })
    ],
    [
      'worktreeOps.create',
      (params) =>
        Effect.gen(function* () {
          const createParams = yield* Effect.try({
            try: () => createWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.create(createParams)
        })
    ],
    [
      'worktreeOps.delete',
      (params) =>
        Effect.gen(function* () {
          const deleteParams = yield* Effect.try({
            try: () => deleteWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.delete(deleteParams)
        })
    ],
    [
      'worktreeOps.sync',
      (params) =>
        Effect.gen(function* () {
          const syncParams = yield* Effect.try({
            try: () => syncWorktreesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.sync(syncParams)
        })
    ],
    [
      'worktreeOps.duplicate',
      (params) =>
        Effect.gen(function* () {
          const duplicateParams = yield* Effect.try({
            try: () => duplicateWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.duplicate(duplicateParams)
        })
    ],
    [
      'worktreeOps.renameBranch',
      (params) =>
        Effect.gen(function* () {
          const renameParams = yield* Effect.try({
            try: () => renameBranchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.renameBranch(renameParams)
        })
    ],
    [
      'worktreeOps.createFromBranch',
      (params) =>
        Effect.gen(function* () {
          const createFromBranchParams = yield* Effect.try({
            try: () => createFromBranchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createFromBranch(createFromBranchParams)
        })
    ],
    [
      'worktreeOps.exists',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.exists(worktreePath)
        })
    ],
    [
      'worktreeOps.openInTerminal',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInTerminal(worktreePath)
        })
    ],
    [
      'worktreeOps.openInEditor',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInEditor(worktreePath)
        })
    ],
    [
      'worktreeOps.getBranches',
      (params) =>
        Effect.gen(function* () {
          const { projectPath } = yield* Effect.try({
            try: () => projectPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranches(projectPath)
        })
    ],
    [
      'worktreeOps.branchExists',
      (params) =>
        Effect.gen(function* () {
          const { projectPath, branchName } = yield* Effect.try({
            try: () => branchExistsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.branchExists(projectPath, branchName)
        })
    ],
    [
      'worktreeOps.getContext',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getContext) {
            return { success: false, error: 'worktreeOps.getContext unavailable' }
          }
          return yield* service.getContext(worktreeId)
        })
    ],
    [
      'worktreeOps.updateContext',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, context } = yield* Effect.try({
            try: () => updateContextParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.updateContext) {
            return { success: false, error: 'worktreeOps.updateContext unavailable' }
          }
          return yield* service.updateContext(worktreeId, context)
        })
    ]
  ])
