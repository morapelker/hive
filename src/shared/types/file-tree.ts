export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

export interface FlatFile {
  name: string
  path: string
  relativePath: string
  extension: string | null
}

export type FileEventType = 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'

export interface FileTreeChangeEventItem {
  eventType: FileEventType
  changedPath: string
  relativePath: string
}

export interface FileTreeChangeEvent {
  worktreePath: string
  events: FileTreeChangeEventItem[]
}

/** Individual file change event */
export interface FileTreeIndividualChangeEvent {
  worktreePath: string
  eventType: FileEventType
  changedPath: string
  relativePath: string
}
