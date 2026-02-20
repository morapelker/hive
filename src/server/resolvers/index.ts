import type { Resolvers } from '../__generated__/resolvers-types'
import { dbQueryResolvers } from './query/db.resolvers'
import { dbMutationResolvers } from './mutation/db.resolvers'

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
  return deepMerge(dbQueryResolvers, dbMutationResolvers)
}
