import { resolve, normalize } from 'node:path'

export class PathGuard {
  private allowedRoots: string[]

  constructor(roots: string[]) {
    this.allowedRoots = roots.map((r) => normalize(resolve(r)))
  }

  addRoot(root: string): void {
    this.allowedRoots.push(normalize(resolve(root)))
  }

  validatePath(inputPath: string): boolean {
    if (!inputPath || inputPath.trim() === '') return false
    const resolved = normalize(resolve(inputPath))
    return this.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + '/')
    )
  }
}

export const PATH_ARG_NAMES = [
  'worktreePath',
  'filePath',
  'dirPath',
  'cwd',
  'path',
  'projectPath'
]
