import type { Resolvers } from '../../__generated__/resolvers-types'
import { initRepository, uploadIcon, removeIcon } from '../../../main/services/project-ops'

export const projectMutationResolvers: Resolvers = {
  Mutation: {
    projectInitRepository: (_parent, { path }) => {
      return initRepository(path)
    },
    projectUploadIcon: (_parent, { projectId, data, filename }) => {
      return uploadIcon(projectId, data, filename)
    },
    projectRemoveIcon: (_parent, { projectId }) => {
      return removeIcon(projectId)
    }
  }
}
