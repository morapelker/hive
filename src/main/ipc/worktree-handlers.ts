import { existsSync } from 'fs'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { openPathWithPreferredEditor, openPathWithPreferredTerminal } from './settings-handlers'
import { createGitService, createLogger } from '../services'
import { telemetryService } from '../services/telemetry-service'
import {
  type CreateWorktreeParams,
  type DeleteWorktreeParams,
  type SyncWorktreesParams,
  type DuplicateWorktreeParams,
  type RenameBranchParams,
  type CreateFromBranchParams
} from '../services/worktree-ops'
import { getDatabase } from '../db'
import { worktreeOpsFacade } from '../effect/db/facade'
import { defineHandler } from './_shared/define-handler'

export type {
  CreateWorktreeParams,
  DeleteWorktreeParams,
  SyncWorktreesParams
} from '../services/worktree-ops'

const log = createLogger({ component: 'WorktreeHandlers' })

class WorktreeHandlerFailed extends Data.TaggedError('WorktreeHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const worktreeFailed = (operation: string, cause: unknown): WorktreeHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new WorktreeHandlerFailed({ operation, reason, message: reason })
}

const createWorktreeSchema = z.object({
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1)
}) satisfies z.ZodType<CreateWorktreeParams>

const deleteWorktreeSchema = z.object({
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  projectPath: z.string().min(1),
  archive: z.boolean()
}) satisfies z.ZodType<DeleteWorktreeParams>

const syncWorktreesSchema = z.object({
  projectId: z.string().min(1),
  projectPath: z.string().min(1)
}) satisfies z.ZodType<SyncWorktreesParams>

const duplicateWorktreeSchema = z.object({
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  sourceBranch: z.string().min(1),
  sourceWorktreePath: z.string().min(1),
  nameHint: z.string().optional()
}) satisfies z.ZodType<DuplicateWorktreeParams>

const renameBranchSchema = z.object({
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  oldBranch: z.string().min(1),
  newBranch: z.string().min(1)
}) satisfies z.ZodType<RenameBranchParams>

const createFromBranchSchema = z.object({
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  branchName: z.string().min(1),
  prNumber: z.number().optional(),
  nameHint: z.string().optional()
}) satisfies z.ZodType<CreateFromBranchParams>

export function registerWorktreeHandlers(): void {
  log.info('Registering worktree handlers')

  // Check if a repository has any commits
  defineHandler('worktree:hasCommits', z.string().min(1), (projectPath) =>
    Effect.tryPromise({
      try: async (): Promise<boolean> => {
        try {
          const gitService = createGitService(projectPath)
          return await gitService.hasCommits()
        } catch {
          return false
        }
      },
      catch: (error) => worktreeFailed('worktree:hasCommits', error)
    })
  )

  // Create a new worktree
  defineHandler('worktree:create', createWorktreeSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.create(params),
      catch: (error) => worktreeFailed('worktree:create', error)
    }).pipe(
      Effect.tap((result) =>
        result.success ? Effect.sync(() => telemetryService.track('worktree_created')) : Effect.void
      )
    )
  )

  // Delete/Archive a worktree
  defineHandler('worktree:delete', deleteWorktreeSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.delete(params),
      catch: (error) => worktreeFailed('worktree:delete', error)
    })
  )

  // Sync worktrees with actual git state
  defineHandler('worktree:sync', syncWorktreesSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.sync(params),
      catch: (error) => worktreeFailed('worktree:sync', error)
    })
  )

  // Duplicate a worktree (clone branch with uncommitted state)
  defineHandler('worktree:duplicate', duplicateWorktreeSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.duplicate(params),
      catch: (error) => worktreeFailed('worktree:duplicate', error)
    })
  )

  // Check if worktree path exists on disk
  defineHandler('worktree:exists', z.string().min(1), (worktreePath) =>
    Effect.try({
      try: () => existsSync(worktreePath),
      catch: (error) => worktreeFailed('worktree:exists', error)
    })
  )

  // Open worktree in user's preferred terminal (from Settings)
  defineHandler('worktree:openInTerminal', z.string().min(1), (worktreePath) =>
    Effect.tryPromise({
      try: () => openPathWithPreferredTerminal(worktreePath),
      catch: (error) => worktreeFailed('worktree:openInTerminal', error)
    })
  )

  // Open worktree in user's preferred editor (from Settings)
  defineHandler('worktree:openInEditor', z.string().min(1), (worktreePath) =>
    Effect.tryPromise({
      try: () => openPathWithPreferredEditor(worktreePath),
      catch: (error) => worktreeFailed('worktree:openInEditor', error)
    })
  )

  // Get git branches for a project
  defineHandler(
    'git:branches',
    z.string().min(1),
    (
      projectPath
    ): Effect.Effect<
      {
        success: boolean
        branches?: string[]
        currentBranch?: string
        error?: string
      },
      WorktreeHandlerFailed
    > =>
      Effect.tryPromise({
        try: async () => {
          try {
            const gitService = createGitService(projectPath)
            const branches = await gitService.getAllBranches()
            const currentBranch = await gitService.getCurrentBranch()

            return {
              success: true,
              branches,
              currentBranch
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            return {
              success: false,
              error: message
            }
          }
        },
        catch: (error) => worktreeFailed('git:branches', error)
      })
  )

  // Check if a branch exists
  defineHandler(
    'git:branchExists',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([projectPath, branchName]) =>
      Effect.tryPromise({
        try: async (): Promise<boolean> => {
          try {
            const gitService = createGitService(projectPath)
            return await gitService.branchExists(branchName)
          } catch {
            return false
          }
        },
        catch: (error) => worktreeFailed('git:branchExists', error)
      })
  )

  // Rename a branch in a worktree
  defineHandler('worktree:renameBranch', renameBranchSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.renameBranch(params),
      catch: (error) => worktreeFailed('worktree:renameBranch', error)
    })
  )

  // List all branches with checkout status
  defineHandler(
    'git:listBranchesWithStatus',
    z.object({ projectPath: z.string().min(1) }),
    ({ projectPath }) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const gitService = createGitService(projectPath)
            const branches = await gitService.listBranchesWithStatus()
            return { success: true, branches }
          } catch (error) {
            return {
              success: false,
              branches: [],
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (error) => worktreeFailed('git:listBranchesWithStatus', error)
      })
  )

  // Create a worktree from a specific existing branch
  defineHandler('worktree:createFromBranch', createFromBranchSchema, (params) =>
    Effect.tryPromise({
      try: () => worktreeOpsFacade.createFromBranch(params),
      catch: (error) => worktreeFailed('worktree:createFromBranch', error)
    })
  )

  // Get worktree context
  defineHandler('worktree:getContext', z.string().min(1), (worktreeId) =>
    Effect.sync(() => {
      try {
        const db = getDatabase()
        const worktree = db.getWorktree(worktreeId)
        if (!worktree) {
          return { success: false, error: 'Worktree not found' }
        }
        return { success: true, context: worktree.context }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    })
  )

  // Update worktree context
  defineHandler(
    'worktree:updateContext',
    z.tuple([z.string().min(1), z.string().nullable()]),
    ([worktreeId, context]) =>
      Effect.sync(() => {
        try {
          const db = getDatabase()
          db.updateWorktreeContext(worktreeId, context)
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )
}
