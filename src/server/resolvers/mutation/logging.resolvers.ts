import type { Resolvers } from '../../__generated__/resolvers-types'
import { createResponseLog, appendResponseLog } from '../../../main/services/response-logger'

export const loggingMutationResolvers: Resolvers = {
  Mutation: {
    createResponseLog: async (_parent, { sessionId }, _ctx) => {
      // Same as ipcMain.handle('logging:createResponseLog', ...)
      // Returns the file path of the newly created log file
      return createResponseLog(sessionId)
    },

    appendResponseLog: async (_parent, { filePath, data }, _ctx) => {
      // Same as ipcMain.handle('logging:appendResponseLog', ...)
      // Appends a JSON line to the log file
      appendResponseLog(filePath, data)
      return true
    }
  }
}
