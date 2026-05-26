import { existsSync } from 'fs'
import { basename } from 'path'
import { Effect, Layer } from 'effect'

import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { DatabaseService } from '../db/database'
import type { Worktree } from '../db/types'
import { worktreeRepo } from '../effect/db/repos/worktrees'
import { makeDbService } from '../effect/db/layers'
import { getRuntime as getDbRuntime } from '../effect/db/runtime'
import { Db } from '../effect/db/service'
import { type BreedType } from './breed-names'
import { createGitService, isAutoNamedBranch } from './git-service'
import { createLogger } from './logger'
import { normalizeWorktreePath } from './path-utils'
import { assignPort, releasePort } from './port-registry'
import { scriptRunner } from './script-runner'

const log = createLogger({ component: 'WorktreeOps' })

export interface CreateWorktreeParams {
  projectId: string
  projectPath: string
  projectName: string
}

export interface DeleteWorktreeParams {
  worktreeId: string
  worktreePath: string
  branchName: string
  projectPath: string
  archive: boolean
}

export interface SyncWorktreesParams {
  projectId: string
  projectPath: string
}

export interface DuplicateWorktreeParams {
  projectId: string
  projectPath: string
  projectName: string
  sourceBranch: string
  sourceWorktreePath: string
  nameHint?: string
}

export interface RenameBranchParams {
  worktreeId: string
  worktreePath: string
  oldBranch: string
  newBranch: string
}

export interface CreateFromBranchParams {
  projectId: string
  projectPath: string
  projectName: string
  branchName: string
  prNumber?: number
  nameHint?: string
}

export interface WorktreeResult {
  success: boolean
  worktree?: Worktree
  error?: string
  pullInfo?: {
    pulled: boolean
    updated: boolean
  }
}

export interface SimpleResult {
  success: boolean
  error?: string
}

function getImportedWorktreeName(branch: string, worktreePath: string): string {
  return branch || basename(worktreePath)
}

export function getBreedType(db: DatabaseService): BreedType {
  try {
    const settingsJson = db.getSetting(APP_SETTINGS_DB_KEY)
    if (settingsJson) {
      const settings = JSON.parse(settingsJson)
      if (settings.breedType === 'cats') return 'cats'
    }
  } catch {
    // Fall back to dogs.
  }
  return 'dogs'
}

export function getAutoPullSetting(db: DatabaseService): boolean {
  try {
    const settingsJson = db.getSetting(APP_SETTINGS_DB_KEY)
    if (settingsJson) {
      const settings = JSON.parse(settingsJson)
      return settings.autoPullBeforeWorktree !== false
    }
  } catch {
    // Default to true if settings can't be read.
  }
  return true
}

const getBreedTypeEffect: Effect.Effect<BreedType, never, Db> = Effect.gen(function* () {
  const db = yield* Db
  const svc = yield* db.raw
  return getBreedType(svc)
})

const getAutoPullEffect: Effect.Effect<boolean, never, Db> = Effect.gen(function* () {
  const db = yield* Db
  const svc = yield* db.raw
  return getAutoPullSetting(svc)
})

const copyContextFromProject = (
  projectId: string,
  targetWorktreeId: string
): Effect.Effect<void, never, Db> =>
  worktreeRepo.getActiveByProject(projectId).pipe(
    Effect.flatMap((existing) => {
      const sourceWithContext = existing.find((w) => w.id !== targetWorktreeId && w.context)
      return sourceWithContext
        ? worktreeRepo.updateContext(targetWorktreeId, sourceWithContext.context)
        : Effect.void
    }),
    Effect.catchAll(() => Effect.void)
  )

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error'

const toEnvelope = <A>(
  eff: Effect.Effect<A, unknown, Db>,
  onSuccess: (a: A) => WorktreeResult,
  context: string
): Effect.Effect<WorktreeResult, never, Db> =>
  eff.pipe(
    Effect.map(onSuccess),
    Effect.catchAll((e) => {
      log.error(`${context} failed`, e instanceof Error ? e : new Error(errMessage(e)))
      return Effect.succeed({ success: false, error: errMessage(e) })
    })
  )

const toSimpleEnvelope = <A>(
  eff: Effect.Effect<A, unknown, Db>,
  context: string
): Effect.Effect<SimpleResult, never, Db> =>
  eff.pipe(
    Effect.map(() => ({ success: true })),
    Effect.catchAll((e) => {
      log.error(`${context} failed`, e instanceof Error ? e : new Error(errMessage(e)))
      return Effect.succeed({ success: false, error: errMessage(e) })
    })
  )

export const createWorktreeOpEffect = (
  params: CreateWorktreeParams
): Effect.Effect<WorktreeResult, never, Db> =>
  toEnvelope(
    Effect.gen(function* () {
      log.info('Creating worktree', {
        projectName: params.projectName,
        projectId: params.projectId
      })
      const breedType = yield* getBreedTypeEffect
      const autoPullEnabled = yield* getAutoPullEffect

      const gitService = createGitService(params.projectPath)
      const result = yield* Effect.tryPromise(() =>
        gitService.createWorktree(params.projectName, breedType, {
          autoPull: autoPullEnabled
        })
      )

      if (!result.success || !result.name || !result.path || !result.branchName) {
        log.warn('Worktree creation failed', {
          error: result.error,
          projectName: params.projectName
        })
        return {
          success: false,
          error: result.error || 'Failed to create worktree'
        }
      }

      const worktree = yield* worktreeRepo.create({
        project_id: params.projectId,
        name: result.name,
        branch_name: result.branchName,
        path: result.path,
        base_branch: result.baseBranch
      })

      yield* copyContextFromProject(params.projectId, worktree.id)

      const db = yield* Db
      const svc = yield* db.raw
      const project = svc.getProject(params.projectId)
      if (project?.auto_assign_port) {
        const port = assignPort(worktree.path)
        log.info('Auto-assigned port to new worktree', {
          worktreeId: worktree.id,
          path: worktree.path,
          port
        })
      }

      log.info('Worktree created successfully', { name: result.name, path: result.path })
      return {
        success: true,
        worktree,
        pullInfo: result.pullInfo
      }
    }),
    (out) => out,
    'createWorktreeOp'
  )

export const deleteWorktreeOpEffect = (
  params: DeleteWorktreeParams
): Effect.Effect<SimpleResult, never, Db> =>
  toSimpleEnvelope(
    Effect.gen(function* () {
      const worktree = yield* worktreeRepo.get(params.worktreeId)
      if (worktree?.is_default) {
        return yield* Effect.fail(new Error('Cannot archive or delete the default worktree'))
      }

      const db = yield* Db
      const svc = yield* db.raw
      const project = worktree?.project_id ? svc.getProject(worktree.project_id) : null
      if (project?.archive_script) {
        const commands = [project.archive_script]
        log.info('Running archive script before worktree deletion', {
          worktreeId: params.worktreeId
        })
        const scriptResult = yield* Effect.tryPromise(() =>
          scriptRunner.runAndWait(commands, params.worktreePath, 30000)
        )
        if (scriptResult.success) {
          log.info('Archive script completed successfully', { output: scriptResult.output })
        } else {
          log.warn('Archive script failed, proceeding with archival anyway', {
            error: scriptResult.error,
            output: scriptResult.output
          })
        }
      }

      const gitService = createGitService(params.projectPath)
      const result = params.archive
        ? yield* Effect.tryPromise(() =>
            gitService.archiveWorktree(params.worktreePath, params.branchName)
          )
        : yield* Effect.tryPromise(() => gitService.removeWorktree(params.worktreePath))

      if (!result.success) {
        return yield* Effect.fail(new Error(result.error || 'Git operation failed'))
      }

      releasePort(params.worktreePath)
      yield* worktreeRepo.archive(params.worktreeId)
    }),
    'deleteWorktreeOp'
  )

export const syncWorktreesOpEffect = (
  params: SyncWorktreesParams
): Effect.Effect<SimpleResult, never, Db> =>
  toSimpleEnvelope(
    Effect.gen(function* () {
      const gitService = createGitService(params.projectPath)
      const normalizedProjectPath = normalizeWorktreePath(params.projectPath)
      const db = yield* Db
      const svc = yield* db.raw
      const project = svc.getProject(params.projectId)

      const gitWorktrees = yield* Effect.tryPromise(() => gitService.listWorktrees())
      const normalizedGitWorktrees = gitWorktrees.map((worktree) => ({
        ...worktree,
        normalizedPath: normalizeWorktreePath(worktree.path)
      }))
      const gitWorktreePaths = new Set(normalizedGitWorktrees.map((w) => w.normalizedPath))

      const dbWorktrees = yield* worktreeRepo.getActiveByProject(params.projectId)
      const dbWorktreePaths = new Set(dbWorktrees.map((w) => normalizeWorktreePath(w.path)))

      for (const gitWorktree of normalizedGitWorktrees) {
        if (
          gitWorktree.normalizedPath === normalizedProjectPath ||
          dbWorktreePaths.has(gitWorktree.normalizedPath)
        ) {
          continue
        }
        if (!existsSync(gitWorktree.path)) {
          log.info('Skipping missing git worktree during sync', {
            projectId: params.projectId,
            path: gitWorktree.path,
            branch: gitWorktree.branch
          })
          continue
        }

        const importedName = getImportedWorktreeName(gitWorktree.branch, gitWorktree.path)
        log.info('Importing git worktree into database', {
          projectId: params.projectId,
          path: gitWorktree.path,
          branch: gitWorktree.branch,
          name: importedName
        })
        const importedWorktree = yield* worktreeRepo.create({
          project_id: params.projectId,
          name: importedName,
          branch_name: gitWorktree.branch,
          path: gitWorktree.path
        })

        if (project?.auto_assign_port) {
          const port = assignPort(importedWorktree.path)
          log.info('Auto-assigned port to imported worktree', {
            worktreeId: importedWorktree.id,
            path: importedWorktree.path,
            port
          })
        }
      }

      const gitBranchByPath = new Map(
        normalizedGitWorktrees.map((w) => [w.normalizedPath, w.branch])
      )

      for (const dbWorktree of dbWorktrees) {
        const normalizedDbWorktreePath = normalizeWorktreePath(dbWorktree.path)
        if (!gitWorktreePaths.has(normalizedDbWorktreePath) && !existsSync(dbWorktree.path)) {
          if (dbWorktree.is_default) continue
          yield* worktreeRepo.archive(dbWorktree.id)
          continue
        }

        const gitBranch = gitBranchByPath.get(normalizedDbWorktreePath)
        if (gitBranch !== undefined && gitBranch !== dbWorktree.branch_name) {
          log.info('Branch renamed externally, updating DB', {
            worktreeId: dbWorktree.id,
            oldBranch: dbWorktree.branch_name,
            newBranch: gitBranch
          })
          const nameMatchesBranch = dbWorktree.name === dbWorktree.branch_name
          const worktreeName = dbWorktree.name.toLowerCase()
          const isAutoName = isAutoNamedBranch(worktreeName)
          const shouldUpdateName = nameMatchesBranch || isAutoName
          const syncedName = getImportedWorktreeName(gitBranch, dbWorktree.path)
          yield* worktreeRepo.update(dbWorktree.id, {
            branch_name: gitBranch,
            ...(shouldUpdateName ? { name: syncedName } : {})
          })
        } else if (gitBranch !== undefined && dbWorktree.name !== dbWorktree.branch_name) {
          const isAutoName = isAutoNamedBranch(dbWorktree.name.toLowerCase())
          if (isAutoName) {
            const healedName = getImportedWorktreeName(dbWorktree.branch_name, dbWorktree.path)
            yield* worktreeRepo.update(dbWorktree.id, { name: healedName })
          }
        }
      }

      yield* Effect.tryPromise(() => gitService.pruneWorktrees())
    }),
    'syncWorktreesOp'
  )

export const duplicateWorktreeOpEffect = (
  params: DuplicateWorktreeParams
): Effect.Effect<WorktreeResult, never, Db> =>
  toEnvelope(
    Effect.gen(function* () {
      log.info('Duplicating worktree', {
        sourceBranch: params.sourceBranch,
        projectName: params.projectName
      })
      if (!params.sourceBranch) {
        return {
          success: false,
          error: 'Detached HEAD worktrees cannot be duplicated'
        }
      }

      const gitService = createGitService(params.projectPath)
      const result = yield* Effect.tryPromise(() =>
        gitService.duplicateWorktree(
          params.sourceBranch,
          params.sourceWorktreePath,
          params.projectName,
          params.nameHint
        )
      )

      if (!result.success || !result.name || !result.path || !result.branchName) {
        log.warn('Worktree duplication failed', { error: result.error })
        return {
          success: false,
          error: result.error || 'Failed to duplicate worktree'
        }
      }

      const worktree = yield* worktreeRepo.create({
        project_id: params.projectId,
        name: result.name,
        branch_name: result.branchName,
        path: result.path,
        base_branch: result.baseBranch
      })

      const sourceWorktree = yield* worktreeRepo.getByPath(params.sourceWorktreePath)
      if (sourceWorktree?.context) {
        yield* worktreeRepo.updateContext(worktree.id, sourceWorktree.context)
      }

      const db = yield* Db
      const svc = yield* db.raw
      const project = svc.getProject(params.projectId)
      if (project?.auto_assign_port) {
        const port = assignPort(worktree.path)
        log.info('Auto-assigned port to duplicated worktree', {
          worktreeId: worktree.id,
          path: worktree.path,
          port
        })
      }

      log.info('Worktree duplicated successfully', { name: result.name, path: result.path })
      return { success: true, worktree }
    }),
    (out) => out,
    'duplicateWorktreeOp'
  )

export const renameWorktreeBranchOpEffect = (
  params: RenameBranchParams
): Effect.Effect<SimpleResult, never, Db> =>
  toSimpleEnvelope(
    Effect.gen(function* () {
      log.info('Renaming worktree branch', {
        worktreePath: params.worktreePath,
        oldBranch: params.oldBranch,
        newBranch: params.newBranch
      })
      if (!params.oldBranch) {
        return yield* Effect.fail(new Error('Detached HEAD worktrees cannot be renamed'))
      }

      const gitService = createGitService(params.worktreePath)
      const result = yield* Effect.tryPromise(() =>
        gitService.renameBranch(params.worktreePath, params.oldBranch, params.newBranch)
      )
      if (!result.success) {
        return yield* Effect.fail(new Error(result.error || 'Rename failed'))
      }

      const worktree = yield* worktreeRepo.get(params.worktreeId)
      const nameMatchesBranch = worktree?.name === params.oldBranch
      const isAutoName = worktree ? isAutoNamedBranch(worktree.name.toLowerCase()) : false
      const shouldUpdateName = nameMatchesBranch || isAutoName

      yield* worktreeRepo.update(params.worktreeId, {
        branch_name: params.newBranch,
        branch_renamed: 1,
        ...(shouldUpdateName
          ? { name: getImportedWorktreeName(params.newBranch, params.worktreePath) }
          : {})
      })
    }),
    'renameWorktreeBranchOp'
  )

export const createWorktreeFromBranchOpEffect = (
  params: CreateFromBranchParams
): Effect.Effect<WorktreeResult, never, Db> =>
  toEnvelope(
    Effect.gen(function* () {
      log.info('Creating worktree from branch', {
        projectName: params.projectName,
        branchName: params.branchName
      })
      const breedType = yield* getBreedTypeEffect
      const autoPullEnabled = yield* getAutoPullEffect

      const gitService = createGitService(params.projectPath)
      const result = yield* Effect.tryPromise(() =>
        gitService.createWorktreeFromBranch(
          params.projectName,
          params.branchName,
          breedType,
          params.prNumber,
          { autoPull: autoPullEnabled, nameHint: params.nameHint }
        )
      )
      if (!result.success || !result.path) {
        return {
          success: false,
          error: result.error || 'Failed to create worktree from branch'
        }
      }

      const worktree = yield* worktreeRepo.create({
        project_id: params.projectId,
        name: result.name || params.branchName,
        branch_name: result.branchName || params.branchName,
        path: result.path,
        base_branch: result.baseBranch
      })

      if (params.nameHint) {
        yield* worktreeRepo.update(worktree.id, { branch_renamed: 1 })
      }

      yield* copyContextFromProject(params.projectId, worktree.id)

      const db = yield* Db
      const svc = yield* db.raw
      const project = svc.getProject(params.projectId)
      if (project?.auto_assign_port) {
        const port = assignPort(worktree.path)
        log.info('Auto-assigned port to worktree from branch', {
          worktreeId: worktree.id,
          path: worktree.path,
          port
        })
      }

      return { success: true, worktree, pullInfo: result.pullInfo }
    }),
    (out) => out,
    'createWorktreeFromBranchOp'
  )

const runWithOptionalDb = <A>(
  effect: Effect.Effect<A, never, Db>,
  db?: DatabaseService
): Promise<A> => {
  if (!db) return getDbRuntime().runPromise(effect)
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Db, makeDbService(db)))))
}

type LegacyOrCurrent<P> = [params: P] | [db: DatabaseService, params: P]

const parseArgs = <P>(args: LegacyOrCurrent<P>): { db?: DatabaseService; params: P } =>
  args.length === 1 ? { params: args[0] } : { db: args[0], params: args[1] }

const hasRawDb = (db: DatabaseService): boolean =>
  typeof (db as unknown as { getRawDb?: unknown }).getRawDb === 'function'

const duplicateWorktreeOpLegacy = async (
  db: DatabaseService,
  params: DuplicateWorktreeParams
): Promise<WorktreeResult> => {
  log.info('Duplicating worktree', {
    sourceBranch: params.sourceBranch,
    projectName: params.projectName
  })

  if (!params.sourceBranch) {
    return {
      success: false,
      error: 'Detached HEAD worktrees cannot be duplicated'
    }
  }

  try {
    const gitService = createGitService(params.projectPath)
    const result = await gitService.duplicateWorktree(
      params.sourceBranch,
      params.sourceWorktreePath,
      params.projectName,
      params.nameHint
    )

    if (!result.success || !result.name || !result.path || !result.branchName) {
      log.warn('Worktree duplication failed', { error: result.error })
      return {
        success: false,
        error: result.error || 'Failed to duplicate worktree'
      }
    }

    const worktree = db.createWorktree({
      project_id: params.projectId,
      name: result.name,
      branch_name: result.branchName,
      path: result.path,
      base_branch: result.baseBranch
    })

    const sourceWorktree = db.getWorktreeByPath(params.sourceWorktreePath)
    if (sourceWorktree?.context) {
      db.updateWorktreeContext(worktree.id, sourceWorktree.context)
    }

    const project = db.getProject(params.projectId)
    if (project?.auto_assign_port) {
      const port = assignPort(worktree.path)
      log.info('Auto-assigned port to duplicated worktree', {
        worktreeId: worktree.id,
        path: worktree.path,
        port
      })
    }

    log.info('Worktree duplicated successfully', { name: result.name, path: result.path })
    return { success: true, worktree }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Worktree duplication error', error instanceof Error ? error : new Error(message), {
      params
    })
    return {
      success: false,
      error: message
    }
  }
}

export function createWorktreeOp(params: CreateWorktreeParams): Promise<WorktreeResult>
export function createWorktreeOp(
  db: DatabaseService,
  params: CreateWorktreeParams
): Promise<WorktreeResult>
export function createWorktreeOp(...args: LegacyOrCurrent<CreateWorktreeParams>): Promise<WorktreeResult> {
  const { db, params } = parseArgs(args)
  return runWithOptionalDb(createWorktreeOpEffect(params), db)
}

export function deleteWorktreeOp(params: DeleteWorktreeParams): Promise<SimpleResult>
export function deleteWorktreeOp(
  db: DatabaseService,
  params: DeleteWorktreeParams
): Promise<SimpleResult>
export function deleteWorktreeOp(...args: LegacyOrCurrent<DeleteWorktreeParams>): Promise<SimpleResult> {
  const { db, params } = parseArgs(args)
  return runWithOptionalDb(deleteWorktreeOpEffect(params), db)
}

export function syncWorktreesOp(params: SyncWorktreesParams): Promise<SimpleResult>
export function syncWorktreesOp(
  db: DatabaseService,
  params: SyncWorktreesParams
): Promise<SimpleResult>
export function syncWorktreesOp(...args: LegacyOrCurrent<SyncWorktreesParams>): Promise<SimpleResult> {
  const { db, params } = parseArgs(args)
  return runWithOptionalDb(syncWorktreesOpEffect(params), db)
}

export function duplicateWorktreeOp(params: DuplicateWorktreeParams): Promise<WorktreeResult>
export function duplicateWorktreeOp(
  db: DatabaseService,
  params: DuplicateWorktreeParams
): Promise<WorktreeResult>
export function duplicateWorktreeOp(...args: LegacyOrCurrent<DuplicateWorktreeParams>): Promise<WorktreeResult> {
  const { db, params } = parseArgs(args)
  if (db && !hasRawDb(db)) return duplicateWorktreeOpLegacy(db, params)
  return runWithOptionalDb(duplicateWorktreeOpEffect(params), db)
}

export function renameWorktreeBranchOp(params: RenameBranchParams): Promise<SimpleResult>
export function renameWorktreeBranchOp(
  db: DatabaseService,
  params: RenameBranchParams
): Promise<SimpleResult>
export function renameWorktreeBranchOp(...args: LegacyOrCurrent<RenameBranchParams>): Promise<SimpleResult> {
  const { db, params } = parseArgs(args)
  return runWithOptionalDb(renameWorktreeBranchOpEffect(params), db)
}

export function createWorktreeFromBranchOp(
  params: CreateFromBranchParams
): Promise<WorktreeResult>
export function createWorktreeFromBranchOp(
  db: DatabaseService,
  params: CreateFromBranchParams
): Promise<WorktreeResult>
export function createWorktreeFromBranchOp(...args: LegacyOrCurrent<CreateFromBranchParams>): Promise<WorktreeResult> {
  const { db, params } = parseArgs(args)
  return runWithOptionalDb(createWorktreeFromBranchOpEffect(params), db)
}
