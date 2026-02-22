import type { Resolvers } from '../../__generated__/resolvers-types'
import { writeFile } from '../../../main/services/file-ops'

export const fileMutationResolvers: Resolvers = {
  Mutation: {
    fileWrite: async (_parent, { filePath, content }) => writeFile(filePath, content),
    fileTreeWatch: async (_parent, { worktreePath: _worktreePath }) => {
      // File tree watching in headless mode — events flow through EventBus
      // Full implementation deferred to subscription wiring
      return { success: true }
    },
    fileTreeUnwatch: async (_parent, { worktreePath: _worktreePath }) => {
      return { success: true }
    }
  }
}
