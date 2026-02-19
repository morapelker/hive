import type { editor } from 'monaco-editor'

/**
 * Structured hunk representation for rendering action buttons.
 */
export interface Hunk {
  index: number
  originalStartLine: number
  originalEndLine: number
  modifiedStartLine: number
  modifiedEndLine: number
  type: 'add' | 'delete' | 'modify'
}

/**
 * Parse Monaco's ILineChange[] into structured Hunk[] for rendering action buttons.
 *
 * Monaco's ILineChange semantics:
 * - EndLineNumber = 0 is a sentinel meaning "no lines on this side"
 * - StartLineNumber is ALWAYS set (as an anchor point for the empty side)
 *
 * Pure addition:  originalEndLineNumber = 0, originalStartLineNumber = anchor
 * Pure deletion:  modifiedEndLineNumber = 0, modifiedStartLineNumber = anchor
 * Modification:   both EndLineNumbers > 0
 */
export function parseHunks(changes: editor.ILineChange[] | null): Hunk[] {
  if (!changes) return []

  return changes.map((change, index) => {
    const isAdd = change.originalEndLineNumber === 0
    const isDelete = change.modifiedEndLineNumber === 0

    return {
      index,
      originalStartLine: change.originalStartLineNumber,
      originalEndLine: change.originalEndLineNumber,
      modifiedStartLine: change.modifiedStartLineNumber,
      modifiedEndLine: change.modifiedEndLineNumber,
      type: isAdd ? 'add' : isDelete ? 'delete' : 'modify'
    }
  })
}

/**
 * Create a unified diff patch string for a single hunk with zero context lines.
 * Used with `git apply --cached --unidiff-zero` which accepts zero-context patches.
 * Zero context avoids context-mismatch errors when staging hunks sequentially
 * (each staged hunk shifts the index, invalidating context from earlier state).
 *
 * @param filePath - Relative file path (e.g., "src/foo.ts")
 * @param originalLines - All lines of the original file (split by \n)
 * @param modifiedLines - All lines of the modified file (split by \n)
 * @param hunk - The hunk to create a patch for
 */
export function createHunkPatch(
  filePath: string,
  originalLines: string[],
  modifiedLines: string[],
  hunk: Hunk
): string {
  const lines: string[] = []

  // Git diff header
  lines.push(`diff --git a/${filePath} b/${filePath}`)
  lines.push('--- a/' + filePath)
  lines.push('+++ b/' + filePath)

  if (hunk.type === 'add') {
    // Pure addition: originalStartLine is the anchor (line BEFORE insertion)
    // originalEndLine = 0 (sentinel). Use anchor as the -side position.
    const anchor = hunk.originalStartLine
    const addCount = hunk.modifiedEndLine - hunk.modifiedStartLine + 1
    const addedLines: string[] = []
    for (let i = hunk.modifiedStartLine; i <= hunk.modifiedEndLine; i++) {
      addedLines.push('+' + (modifiedLines[i - 1] ?? ''))
    }
    lines.push(`@@ -${anchor},0 +${hunk.modifiedStartLine},${addCount} @@`)
    lines.push(...addedLines)
  } else if (hunk.type === 'delete') {
    // Pure deletion: modifiedStartLine is the anchor (line BEFORE deletion)
    // modifiedEndLine = 0 (sentinel). Use anchor as the +side position.
    const anchor = hunk.modifiedStartLine
    const delCount = hunk.originalEndLine - hunk.originalStartLine + 1
    const deletedLines: string[] = []
    for (let i = hunk.originalStartLine; i <= hunk.originalEndLine; i++) {
      deletedLines.push('-' + (originalLines[i - 1] ?? ''))
    }
    lines.push(`@@ -${hunk.originalStartLine},${delCount} +${anchor},0 @@`)
    lines.push(...deletedLines)
  } else {
    // Modification: replace original lines with modified lines
    const origCount = hunk.originalEndLine - hunk.originalStartLine + 1
    const modCount = hunk.modifiedEndLine - hunk.modifiedStartLine + 1
    const deletedLines: string[] = []
    for (let i = hunk.originalStartLine; i <= hunk.originalEndLine; i++) {
      deletedLines.push('-' + (originalLines[i - 1] ?? ''))
    }
    const addedLines: string[] = []
    for (let i = hunk.modifiedStartLine; i <= hunk.modifiedEndLine; i++) {
      addedLines.push('+' + (modifiedLines[i - 1] ?? ''))
    }
    lines.push(
      `@@ -${hunk.originalStartLine},${origCount} +${hunk.modifiedStartLine},${modCount} @@`
    )
    lines.push(...deletedLines)
    lines.push(...addedLines)
  }

  // Ensure trailing newline
  return lines.join('\n') + '\n'
}

/**
 * Map file extensions to Monaco language IDs for syntax highlighting.
 */
const extensionToLanguage: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'html',
  '.svelte': 'html',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.dart': 'dart',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala'
}

/**
 * Get the Monaco language ID for a given file path.
 */
export function getMonacoLanguage(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile') return 'plaintext'
  return extensionToLanguage[ext] || 'plaintext'
}
