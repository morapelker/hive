import type { Resolvers } from '../../__generated__/resolvers-types'
import { getAssignedPort } from '../../../main/services/port-registry'

export const scriptQueryResolvers: Resolvers = {
  Query: {
    scriptPort: async (_parent, { cwd }, _ctx) => {
      return getAssignedPort(cwd)
    }
  }
}
