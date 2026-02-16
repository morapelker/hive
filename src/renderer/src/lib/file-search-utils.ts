export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
}

export interface FlatFile {
  name: string
  path: string
  relativePath: string
  extension: string | null
}

// Flatten file tree to searchable array
export function flattenTree(nodes: FileTreeNode[]): FlatFile[] {
  const result: FlatFile[] = []
  const walk = (items: FileTreeNode[]): void => {
    for (const node of items) {
      if (!node.isDirectory) {
        result.push({
          name: node.name,
          path: node.path,
          relativePath: node.relativePath,
          extension: node.extension
        })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

// Fuzzy match scoring
export function scoreMatch(query: string, file: { name: string; relativePath: string }): number {
  const q = query.toLowerCase()
  const name = file.name.toLowerCase()
  const path = file.relativePath.toLowerCase()

  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  if (path.includes(q)) return 40

  // Subsequence match
  let qi = 0
  for (let i = 0; i < path.length && qi < q.length; i++) {
    if (path[i] === q[qi]) qi++
  }
  return qi === q.length ? 20 : 0
}
