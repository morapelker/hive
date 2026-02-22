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

export interface FileTreeChangeEvent {
  worktreePath: string
  eventType: 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'
  changedPath: string
  relativePath: string
}
