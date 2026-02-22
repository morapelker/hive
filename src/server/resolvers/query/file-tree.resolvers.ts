import type { Resolvers } from '../../__generated__/resolvers-types'
import { existsSync, statSync } from 'fs'
import { scanDirectory, scanSingleDirectory, scanFlat } from '../../../main/ipc/file-tree-handlers'

export const fileTreeQueryResolvers: Resolvers = {
  Query: {
    fileTreeScan: async (_parent, { dirPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        if (!statSync(dirPath).isDirectory())
          return { success: false, error: 'Path is not a directory' }
        const tree = await scanDirectory(dirPath, dirPath)
        return { success: true, tree }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    fileTreeScanFlat: async (_parent, { dirPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        if (!statSync(dirPath).isDirectory())
          return { success: false, error: 'Path is not a directory' }
        const files = await scanFlat(dirPath)
        return { success: true, files }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    fileTreeLoadChildren: async (_parent, { dirPath, rootPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        const children = await scanSingleDirectory(dirPath, rootPath)
        return { success: true, children }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
