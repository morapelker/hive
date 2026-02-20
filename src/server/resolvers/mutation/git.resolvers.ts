import { exec } from 'child_process'
import { promisify } from 'util'
import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  createGitService,
  parseWorktreeForBranch
} from '../../../main/services/git-service'
import { getEventBus } from '../../event-bus'
import { watchWorktree, unwatchWorktree } from '../../../main/services/worktree-watcher'
import { watchBranch, unwatchBranch } from '../../../main/services/branch-watcher'

const execAsync = promisify(exec)

export const gitMutationResolvers: Resolvers = {
  Mutation: {
    // ── Staging ────────────────────────────────────────────────────

    gitStageFile: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageFile(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitUnstageFile: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageFile(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitStageAll: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageAll()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitUnstageAll: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageAll()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitStageHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitUnstageHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitRevertHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.revertHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    // ── Commit / Push / Pull ──────────────────────────────────────

    gitDiscardChanges: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.discardChanges(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitAddToGitignore: async (_parent, { worktreePath, pattern }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.addToGitignore(pattern)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitCommit: async (_parent, { worktreePath, message }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.commit(message)
      } catch (error) {
        return {
          success: false,
          commitHash: null,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitPush: async (_parent, { input }) => {
      try {
        const gitService = createGitService(input.worktreePath)
        const result = await gitService.push(
          input.remote ?? undefined,
          input.branch ?? undefined,
          input.force ?? undefined
        )
        return { success: result.success, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitPull: async (_parent, { input }) => {
      try {
        const gitService = createGitService(input.worktreePath)
        const result = await gitService.pull(
          input.remote ?? undefined,
          input.branch ?? undefined,
          input.rebase ?? undefined
        )
        return { success: result.success, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    // ── Merge / Branch ────────────────────────────────────────────

    gitMerge: async (_parent, { worktreePath, sourceBranch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.merge(sourceBranch)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          conflicts: null
        }
      }
    },

    gitDeleteBranch: async (_parent, { worktreePath, branchName }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.deleteBranch(branchName)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitPrMerge: async (_parent, { worktreePath, prNumber }) => {
      try {
        // Step 1: Merge the PR on GitHub
        await execAsync(`gh pr merge ${prNumber} --merge`, { cwd: worktreePath })

        // Step 2: Get the target branch name
        const prInfoResult = await execAsync(
          `gh pr view ${prNumber} --json baseRefName -q '.baseRefName'`,
          { cwd: worktreePath }
        )
        const targetBranch = prInfoResult.stdout.trim()

        // Step 3: Find local worktree on target branch and sync
        const worktreeListResult = await execAsync('git worktree list --porcelain', {
          cwd: worktreePath
        })
        const targetWorktreePath = parseWorktreeForBranch(
          worktreeListResult.stdout,
          targetBranch
        )

        if (targetWorktreePath) {
          const currentBranch = await execAsync('git branch --show-current', {
            cwd: worktreePath
          })
          await execAsync(`git merge ${currentBranch.stdout.trim()}`, {
            cwd: targetWorktreePath
          })
        }

        // Step 4: Emit status changed event
        try {
          getEventBus().emit('git:statusChanged', { worktreePath })
        } catch {
          /* EventBus not available */
        }

        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    // ── Watching ──────────────────────────────────────────────────

    gitWatchWorktree: async (_parent, { worktreePath }) => {
      try {
        await watchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitUnwatchWorktree: async (_parent, { worktreePath }) => {
      try {
        await unwatchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitWatchBranch: async (_parent, { worktreePath }) => {
      try {
        await watchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitUnwatchBranch: async (_parent, { worktreePath }) => {
      try {
        await unwatchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
