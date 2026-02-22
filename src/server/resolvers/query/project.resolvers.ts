import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  validateProject,
  isGitRepository,
  detectProjectLanguage,
  loadLanguageIcons,
  getIconDataUrl
} from '../../../main/services/project-ops'

export const projectQueryResolvers: Resolvers = {
  Query: {
    projectValidate: (_parent, { path }) => {
      return validateProject(path)
    },
    projectIsGitRepository: (_parent, { path }) => {
      return isGitRepository(path)
    },
    projectDetectLanguage: async (_parent, { projectPath }) => {
      return detectProjectLanguage(projectPath)
    },
    projectLanguageIcons: () => {
      return loadLanguageIcons()
    },
    projectIconPath: (_parent, { filename }) => {
      return getIconDataUrl(filename)
    }
  }
}
