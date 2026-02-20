import { existsSync } from 'fs'
import type { Resolvers } from '../../__generated__/resolvers-types'
import { createGitService } from '../../../main/services/git-service'

export const worktreeQueryResolvers: Resolvers = {
  Query: {
    worktreeExists: (_parent, { worktreePath }) => {
      return existsSync(worktreePath)
    },
    worktreeHasCommits: async (_parent, { projectPath }) => {
      const gitService = createGitService(projectPath)
      return gitService.hasCommits()
    },
    gitBranches: async (_parent, { projectPath }) => {
      try {
        const gitService = createGitService(projectPath)
        const [branches, currentBranch] = await Promise.all([
          gitService.getAllBranches(),
          gitService.getCurrentBranch()
        ])
        return { success: true, branches, currentBranch }
      } catch (error) {
        return {
          success: false,
          branches: null,
          currentBranch: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },
    gitBranchExists: async (_parent, { projectPath, branchName }) => {
      const gitService = createGitService(projectPath)
      return gitService.branchExists(branchName)
    }
  }
}
