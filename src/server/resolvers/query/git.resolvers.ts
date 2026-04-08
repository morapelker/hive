import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { Resolvers } from '../../__generated__/resolvers-types'
import { createGitService } from '../../../main/services/git-service'
import { readFileAsBase64 } from '../../../main/services/file-ops'

const execAsync = promisify(exec)

export const gitQueryResolvers: Resolvers = {
  Query: {
    gitFileStatuses: async (_parent, { worktreePath }, _ctx) => {
      try {
        // Defense-in-depth: skip git ops for non-git directories
        if (!existsSync(join(worktreePath, '.git'))) {
          return { success: true, files: [] }
        }
        const gitService = createGitService(worktreePath)
        return await gitService.getFileStatuses()
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitDiff: async (_parent, { input }, _ctx) => {
      try {
        const { worktreePath, filePath, staged, isUntracked, contextLines } = input
        const gitService = createGitService(worktreePath)

        if (isUntracked) {
          return await gitService.getUntrackedFileDiff(filePath)
        }

        return await gitService.getDiff(filePath, staged, contextLines ?? undefined)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitDiffStat: async (_parent, { worktreePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getDiffStat()
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitFileContent: async (_parent, { worktreePath, filePath }, _ctx) => {
      try {
        const fullPath = join(worktreePath, filePath)
        const content = await readFile(fullPath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitRefContent: async (_parent, { worktreePath, ref, filePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRefContent(ref, filePath)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitBranchInfo: async (_parent, { worktreePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchInfo()
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitBranchesWithStatus: async (_parent, { projectPath }, _ctx) => {
      try {
        const gitService = createGitService(projectPath)
        const branches = await gitService.listBranchesWithStatus()
        return { success: true, branches }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitIsBranchMerged: async (_parent, { worktreePath, branch }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.isBranchMerged(branch)
      } catch {
        return { success: false, isMerged: false }
      }
    },

    gitRemoteUrl: async (_parent, { worktreePath, remote }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRemoteUrl(remote || 'origin')
      } catch (error) {
        return {
          success: false,
          url: null,
          remote: null,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitListPRs: async (_parent, { projectPath }, _ctx) => {
      try {
        // Fetch latest remote refs so PR branches are available
        await execAsync('git fetch origin', { cwd: projectPath })

        const { stdout } = await execAsync(
          'gh pr list --json number,title,author,headRefName --state open --limit 100',
          { cwd: projectPath }
        )
        const raw = JSON.parse(stdout) as Array<{
          number: number
          title: string
          author: { login: string }
          headRefName: string
        }>
        const prs = raw.map((pr) => ({
          number: pr.number,
          title: pr.title,
          author: pr.author.login,
          headRefName: pr.headRefName
        }))
        return { success: true, prs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (message.includes('gh: command not found') || message.includes('not found')) {
          return { success: false, prs: [], error: 'GitHub CLI (gh) is not installed' }
        }
        if (message.includes('not a git repository')) {
          return { success: false, prs: [], error: 'Not a git repository' }
        }
        if (message.includes('Could not resolve to a Repository')) {
          return {
            success: false,
            prs: [],
            error: 'Not a GitHub repository or not authenticated with gh'
          }
        }
        return { success: false, prs: [], error: message }
      }
    },

    gitBranchDiffFiles: async (_parent, { worktreePath, baseBranch }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getBranchDiffFiles(baseBranch)
        if (!result.success) {
          return { success: false, error: result.error }
        }
        const files = (result.files ?? []).map((f) => ({
          path: f.relativePath,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary
        }))
        return { success: true, files }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitBranchFileDiff: async (_parent, { worktreePath, baseBranch, filePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchFileDiff(baseBranch, filePath)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitFileContentBase64: async (_parent, { worktreePath, filePath }, _ctx) => {
      try {
        const fullPath = join(worktreePath, filePath)
        const result = readFileAsBase64(fullPath)
        if (!result.success) {
          return { success: false, error: result.error }
        }
        return { success: true, content: result.data, mimeType: result.mimeType }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitRefContentBase64: async (_parent, { worktreePath, ref, filePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getRefContentBase64(ref, filePath)
        if (!result.success) {
          return { success: false, error: result.error }
        }
        return { success: true, content: result.data, mimeType: result.mimeType }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    gitPRState: async (_parent, { worktreePath, prNumber }, _ctx) => {
      try {
        const { stdout } = await execAsync(
          `gh pr view ${prNumber} --json state,merged`,
          { cwd: worktreePath }
        )
        const raw = JSON.parse(stdout) as { state: string; merged: boolean }
        return { success: true, state: raw.state, merged: raw.merged }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('gh: command not found') || message.includes('not found')) {
          return { success: false, error: 'GitHub CLI (gh) is not installed' }
        }
        return { success: false, error: message }
      }
    },

    gitPRReviewComments: async (_parent, { worktreePath, prNumber }, _ctx) => {
      try {
        const { stdout } = await execAsync(
          `gh pr view ${prNumber} --json reviews`,
          { cwd: worktreePath }
        )
        const raw = JSON.parse(stdout) as {
          reviews: Array<{
            body: string
            author: { login: string }
            submittedAt: string
            comments: Array<{
              id: number
              path: string
              line: number
              body: string
              author: { login: string }
              createdAt: string
            }>
          }>
        }
        const comments: Array<{
          id: number
          path: string | null
          line: number | null
          body: string
          user: { login: string }
          createdAt: string
        }> = []
        for (const review of raw.reviews) {
          for (const comment of review.comments) {
            comments.push({
              id: comment.id,
              path: comment.path || null,
              line: comment.line || null,
              body: comment.body,
              user: { login: comment.author?.login ?? review.author.login },
              createdAt: comment.createdAt
            })
          }
        }
        return { success: true, comments }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('gh: command not found') || message.includes('not found')) {
          return { success: false, error: 'GitHub CLI (gh) is not installed' }
        }
        return { success: false, error: message }
      }
    },

    gitRangeDiff: async (_parent, { worktreePath, baseBranch }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRangeDiff(baseBranch)
      } catch (error) {
        return {
          commitSummary: '',
          diffSummary: '',
          diffPatch: '',
          commitCount: 0
        }
      }
    },

    gitNeedsPush: async (_parent, { worktreePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.needsPush()
      } catch {
        return false
      }
    }
  }
}
