import type { Resolvers } from '../../__generated__/resolvers-types'
import { scriptRunner } from '../../../main/services/script-runner'

export const scriptMutationResolvers: Resolvers = {
  Mutation: {
    scriptRunSetup: async (_parent, { input }, _ctx) => {
      try {
        const result = await scriptRunner.runSequential(
          input.commands,
          input.cwd,
          input.worktreeId
        )
        return { success: result.success, error: result.error }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    scriptRunProject: async (_parent, { input }, _ctx) => {
      try {
        const result = await scriptRunner.runPersistent(
          input.commands,
          input.cwd,
          input.worktreeId
        )
        return { success: true, pid: result.pid }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    scriptKill: async (_parent, { worktreeId }, _ctx) => {
      try {
        await scriptRunner.killProcess(worktreeId)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    scriptRunArchive: async (_parent, { commands, cwd }, _ctx) => {
      try {
        const result = await scriptRunner.runAndWait(commands, cwd)
        return {
          success: result.success,
          output: result.output,
          error: result.error
        }
      } catch (error) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  }
}
