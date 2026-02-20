import { existsSync } from 'fs'
import { createGitService, isAutoNamedBranch } from './git-service'
import { type BreedType } from './breed-names'
import { scriptRunner } from './script-runner'
import { assignPort, releasePort } from './port-registry'
import { createLogger } from './logger'
import type { DatabaseService } from '../db/database'

const log = createLogger({ component: 'WorktreeOps' })

// ── Parameter types ─────────────────────────────────────────────

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
  archive: boolean // true = Archive (delete branch), false = Unbranch (keep branch)
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
}

// ── Result types ────────────────────────────────────────────────

export interface WorktreeResult {
  success: boolean
  worktree?: {
    id: string
    project_id: string
    name: string
    branch_name: string
    path: string
    status: string
    created_at: string
    last_accessed_at: string
  }
  error?: string
}

export interface SimpleResult {
  success: boolean
  error?: string
}

// ── Helpers ─────────────────────────────────────────────────────

export function getBreedType(db: DatabaseService): BreedType {
  try {
    const settingsJson = db.getSetting('app_settings')
    if (settingsJson) {
      const settings = JSON.parse(settingsJson)
      if (settings.breedType === 'cats') {
        return 'cats'
      }
    }
  } catch {
    // Fall back to dogs
  }
  return 'dogs'
}

// ── Operations ──────────────────────────────────────────────────

export async function createWorktreeOp(
  db: DatabaseService,
  params: CreateWorktreeParams
): Promise<WorktreeResult> {
  log.info('Creating worktree', {
    projectName: params.projectName,
    projectId: params.projectId
  })
  try {
    const gitService = createGitService(params.projectPath)

    // Read breed type preference from settings
    const breedType = getBreedType(db)

    const result = await gitService.createWorktree(params.projectName, breedType)

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

    // Create database entry
    const worktree = db.createWorktree({
      project_id: params.projectId,
      name: result.name,
      branch_name: result.branchName,
      path: result.path
    })

    // Auto-assign port if project has it enabled
    const project = db.getProject(params.projectId)
    if (project && project.auto_assign_port) {
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
      worktree
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Worktree creation error', error instanceof Error ? error : new Error(message), {
      params
    })
    return {
      success: false,
      error: message
    }
  }
}

export async function deleteWorktreeOp(
  db: DatabaseService,
  params: DeleteWorktreeParams
): Promise<SimpleResult> {
  try {
    // Guard: block delete/archive of default worktrees
    const worktree = db.getWorktree(params.worktreeId)
    if (worktree?.is_default) {
      return {
        success: false,
        error: 'Cannot archive or delete the default worktree'
      }
    }

    // Run archive script if configured (before git operations)
    const project = worktree?.project_id ? db.getProject(worktree.project_id) : null
    if (project?.archive_script) {
      // Pass raw script lines -- scriptRunner.parseCommands handles splitting/filtering
      const commands = [project.archive_script]
      log.info('Running archive script before worktree deletion', {
        worktreeId: params.worktreeId
      })
      const scriptResult = await scriptRunner.runAndWait(commands, params.worktreePath, 30000)
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

    let result
    if (params.archive) {
      // Archive: remove worktree AND delete branch
      result = await gitService.archiveWorktree(params.worktreePath, params.branchName)
    } else {
      // Unbranch: remove worktree but keep branch
      result = await gitService.removeWorktree(params.worktreePath)
    }

    if (!result.success) {
      return result
    }

    // Release any assigned port for this worktree
    releasePort(params.worktreePath)

    // Update database - archive the worktree record
    db.archiveWorktree(params.worktreeId)

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: message
    }
  }
}

export async function syncWorktreesOp(
  db: DatabaseService,
  params: SyncWorktreesParams
): Promise<SimpleResult> {
  try {
    const gitService = createGitService(params.projectPath)

    // Get actual worktrees from git
    const gitWorktrees = await gitService.listWorktrees()
    const gitWorktreePaths = new Set(gitWorktrees.map((w) => w.path))

    // Get database worktrees
    const dbWorktrees = db.getActiveWorktreesByProject(params.projectId)

    // Build a map of git worktree path -> branch for quick lookup
    const gitBranchByPath = new Map(gitWorktrees.map((w) => [w.path, w.branch]))

    // Check each database worktree
    for (const dbWorktree of dbWorktrees) {
      // If worktree path doesn't exist in git worktrees or on disk
      if (!gitWorktreePaths.has(dbWorktree.path) && !existsSync(dbWorktree.path)) {
        // Mark as archived (worktree was removed outside of Hive)
        db.archiveWorktree(dbWorktree.id)
        continue
      }

      // Sync branch name if it was renamed outside of Hive
      const gitBranch = gitBranchByPath.get(dbWorktree.path)
      if (gitBranch && gitBranch !== dbWorktree.branch_name && !dbWorktree.branch_renamed) {
        log.info('Branch renamed externally, updating DB', {
          worktreeId: dbWorktree.id,
          oldBranch: dbWorktree.branch_name,
          newBranch: gitBranch
        })
        // Update branch_name always. Also update display name if it still matches
        // the old branch name OR is a city placeholder name (never meaningfully customized).
        const nameMatchesBranch = dbWorktree.name === dbWorktree.branch_name
        const worktreeName = dbWorktree.name.toLowerCase()
        const isAutoName = isAutoNamedBranch(worktreeName)
        const shouldUpdateName = nameMatchesBranch || isAutoName
        db.updateWorktree(dbWorktree.id, {
          branch_name: gitBranch,
          ...(shouldUpdateName ? { name: gitBranch } : {})
        })
      }
    }

    // Prune any stale git worktree entries
    await gitService.pruneWorktrees()

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: message
    }
  }
}

export async function duplicateWorktreeOp(
  db: DatabaseService,
  params: DuplicateWorktreeParams
): Promise<WorktreeResult> {
  log.info('Duplicating worktree', {
    sourceBranch: params.sourceBranch,
    projectName: params.projectName
  })
  try {
    const gitService = createGitService(params.projectPath)
    const result = await gitService.duplicateWorktree(
      params.sourceBranch,
      params.sourceWorktreePath,
      params.projectName
    )

    if (!result.success || !result.name || !result.path || !result.branchName) {
      log.warn('Worktree duplication failed', { error: result.error })
      return {
        success: false,
        error: result.error || 'Failed to duplicate worktree'
      }
    }

    // Create database entry
    const worktree = db.createWorktree({
      project_id: params.projectId,
      name: result.name,
      branch_name: result.branchName,
      path: result.path
    })

    // Auto-assign port if project has it enabled
    const project = db.getProject(params.projectId)
    if (project && project.auto_assign_port) {
      const port = assignPort(worktree.path)
      log.info('Auto-assigned port to duplicated worktree', {
        worktreeId: worktree.id,
        path: worktree.path,
        port
      })
    }

    log.info('Worktree duplicated successfully', { name: result.name, path: result.path })
    return {
      success: true,
      worktree
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error(
      'Worktree duplication error',
      error instanceof Error ? error : new Error(message),
      { params }
    )
    return {
      success: false,
      error: message
    }
  }
}

export async function renameWorktreeBranchOp(
  db: DatabaseService,
  params: RenameBranchParams
): Promise<SimpleResult> {
  log.info('Renaming worktree branch', {
    worktreePath: params.worktreePath,
    oldBranch: params.oldBranch,
    newBranch: params.newBranch
  })
  try {
    const gitService = createGitService(params.worktreePath)
    const result = await gitService.renameBranch(
      params.worktreePath,
      params.oldBranch,
      params.newBranch
    )
    if (result.success) {
      db.updateWorktree(params.worktreeId, {
        branch_name: params.newBranch,
        branch_renamed: 1
      })
    }
    return result
  } catch (error) {
    log.error(
      'Rename worktree branch failed',
      error instanceof Error ? error : new Error('Unknown error')
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function createWorktreeFromBranchOp(
  db: DatabaseService,
  params: CreateFromBranchParams
): Promise<WorktreeResult> {
  log.info('Creating worktree from branch', {
    projectName: params.projectName,
    branchName: params.branchName
  })
  try {
    // Read breed type preference from settings
    const breedType = getBreedType(db)

    const gitService = createGitService(params.projectPath)
    const result = await gitService.createWorktreeFromBranch(
      params.projectName,
      params.branchName,
      breedType
    )
    if (!result.success || !result.path) {
      return { success: false, error: result.error || 'Failed to create worktree from branch' }
    }
    const worktree = db.createWorktree({
      project_id: params.projectId,
      name: result.name || params.branchName,
      branch_name: result.branchName || params.branchName,
      path: result.path
    })

    // Auto-assign port if project has it enabled
    const project = db.getProject(params.projectId)
    if (project && project.auto_assign_port) {
      const port = assignPort(worktree.path)
      log.info('Auto-assigned port to worktree from branch', {
        worktreeId: worktree.id,
        path: worktree.path,
        port
      })
    }

    return { success: true, worktree }
  } catch (error) {
    log.error(
      'Create worktree from branch failed',
      error instanceof Error ? error : new Error('Unknown error')
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
