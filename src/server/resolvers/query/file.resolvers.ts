import type { Resolvers } from '../../__generated__/resolvers-types'
import { readFile, readPromptFile } from '../../../main/services/file-ops'

export const fileQueryResolvers: Resolvers = {
  Query: {
    fileRead: async (_parent, { filePath }) => readFile(filePath),
    fileReadPrompt: async (_parent, { promptName }) => readPromptFile(promptName)
  }
}
