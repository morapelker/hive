import type { Resolvers } from '../__generated__/resolvers-types'
import { dbQueryResolvers } from './query/db.resolvers'
import { systemQueryResolvers } from './query/system.resolvers'
import { settingsQueryResolvers } from './query/settings.resolvers'
import { fileQueryResolvers } from './query/file.resolvers'
import { fileTreeQueryResolvers } from './query/file-tree.resolvers'
import { dbMutationResolvers } from './mutation/db.resolvers'
import { systemMutationResolvers } from './mutation/system.resolvers'
import { fileMutationResolvers } from './mutation/file.resolvers'
import { projectQueryResolvers } from './query/project.resolvers'
import { projectMutationResolvers } from './mutation/project.resolvers'
import { worktreeQueryResolvers } from './query/worktree.resolvers'
import { gitQueryResolvers } from './query/git.resolvers'
import { worktreeMutationResolvers } from './mutation/worktree.resolvers'
import { gitMutationResolvers } from './mutation/git.resolvers'

function deepMerge(...objects: Resolvers[]): Resolvers {
  const result: Record<string, unknown> = {}
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        result[key] = { ...(result[key] as Record<string, unknown>), ...value }
      } else {
        result[key] = value
      }
    }
  }
  return result as Resolvers
}

export function mergeResolvers(): Resolvers {
  return deepMerge(
    dbQueryResolvers,
    systemQueryResolvers,
    settingsQueryResolvers,
    fileQueryResolvers,
    fileTreeQueryResolvers,
    dbMutationResolvers,
    systemMutationResolvers,
    fileMutationResolvers,
    projectQueryResolvers,
    projectMutationResolvers,
    worktreeQueryResolvers,
    gitQueryResolvers,
    worktreeMutationResolvers,
    gitMutationResolvers
  )
}
