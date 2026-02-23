import type { Resolvers } from '../../__generated__/resolvers-types'
import { detectEditors, detectTerminals } from '../../../main/services/settings-detection'

export const settingsQueryResolvers: Resolvers = {
  Query: {
    detectedEditors: () => detectEditors(),
    detectedTerminals: () => detectTerminals()
  }
}
