import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronUp,
  ChevronDown,
  Columns2,
  AlignJustify,
  Copy,
  X,
  Loader2,
  ChevronsUpDown
} from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { DiffViewer, type DiffViewMode } from './DiffViewer'
import { cn } from '@/lib/utils'

// Map file extensions to Prism language identifiers
const extensionToLanguage: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
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
  '.kts': 'kotlin',
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
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'bash',
  '.dockerfile': 'docker',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.zig': 'zig',
  '.elm': 'elm',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.clj': 'clojure',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.tf': 'hcl',
  '.proto': 'protobuf',
  '.bat': 'batch',
  '.cmd': 'batch'
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore' || name === '.dockerignore') return 'bash'
  return extensionToLanguage[ext] || 'text'
}

interface InlineDiffViewerProps {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  onClose: () => void
}

export function InlineDiffViewer({
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked,
  isNewFile,
  onClose
}: InlineDiffViewerProps): React.JSX.Element {
  const [diff, setDiff] = useState<string>('')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified')
  const [contextLines, setContextLines] = useState(3)
  const [currentHunkIndex, setCurrentHunkIndex] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)

  // Fetch file content for new files
  const fetchFileContent = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.gitOps.getFileContent(worktreePath, filePath)
      if (result.success && result.content !== null) {
        setFileContent(result.content)
      } else {
        setError(result.error || 'Failed to load file content')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file content')
    } finally {
      setIsLoading(false)
    }
  }, [worktreePath, filePath])

  // Fetch diff
  const fetchDiff = useCallback(
    async (ctx: number) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await window.gitOps.getDiff(worktreePath, filePath, staged, isUntracked, ctx)
        if (result.success && result.diff) {
          setDiff(result.diff)
        } else {
          setError(result.error || 'Failed to load diff')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load diff')
      } finally {
        setIsLoading(false)
      }
    },
    [worktreePath, filePath, staged, isUntracked]
  )

  // Load on mount and when contextLines changes
  useEffect(() => {
    if (isNewFile) {
      fetchFileContent()
    } else {
      fetchDiff(contextLines)
    }
  }, [isNewFile, fetchFileContent, fetchDiff, contextLines])

  // Get hunk elements
  const getHunkElements = useCallback((): Element[] => {
    if (!contentRef.current) return []
    return Array.from(
      contentRef.current.querySelectorAll('.d2h-info, .d2h-code-linenumber.d2h-info')
    )
  }, [])

  // Navigate to next hunk
  const goToNextHunk = useCallback(() => {
    const hunks = getHunkElements()
    if (hunks.length === 0) return
    const nextIndex = currentHunkIndex + 1 < hunks.length ? currentHunkIndex + 1 : 0
    setCurrentHunkIndex(nextIndex)
    hunks[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [getHunkElements, currentHunkIndex])

  // Navigate to previous hunk
  const goToPrevHunk = useCallback(() => {
    const hunks = getHunkElements()
    if (hunks.length === 0) return
    const prevIndex = currentHunkIndex - 1 >= 0 ? currentHunkIndex - 1 : hunks.length - 1
    setCurrentHunkIndex(prevIndex)
    hunks[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [getHunkElements, currentHunkIndex])

  // Expand context
  const handleExpandContext = useCallback(() => {
    setContextLines((prev) => prev + 10)
  }, [])

  // Copy content to clipboard
  const handleCopyDiff = useCallback(async () => {
    const content = isNewFile ? fileContent : diff
    if (content) {
      await window.projectOps.copyToClipboard(content)
      toast.success(isNewFile ? 'File content copied to clipboard' : 'Diff copied to clipboard')
    }
  }, [diff, fileContent, isNewFile])

  // Toggle view mode
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === 'unified' ? 'split' : 'unified'))
  }, [])

  // Keyboard shortcuts for hunk navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        goToNextHunk()
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        goToPrevHunk()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goToNextHunk, goToPrevHunk, onClose])

  const statusLabel = isNewFile
    ? 'New file'
    : staged
      ? 'Staged'
      : isUntracked
        ? 'New file'
        : 'Unstaged'

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="inline-diff-viewer">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate" data-testid="inline-diff-filename">
            {fileName}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Hunk navigation */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={goToPrevHunk}
            title="Previous hunk (Alt+Up)"
            data-testid="diff-prev-hunk"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={goToNextHunk}
            title="Next hunk (Alt+Down)"
            data-testid="diff-next-hunk"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Context expansion */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleExpandContext}
            title="Show more context"
            data-testid="diff-expand-context"
          >
            <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
            More context
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* View mode toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={toggleViewMode}
            title={viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
            data-testid="diff-view-toggle"
          >
            {viewMode === 'unified' ? (
              <Columns2 className="h-3.5 w-3.5" />
            ) : (
              <AlignJustify className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Copy */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCopyDiff}
            disabled={isNewFile ? !fileContent : !diff}
            title="Copy diff to clipboard"
            data-testid="diff-copy-button"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Close */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close diff (Esc)"
            data-testid="diff-close-button"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Diff content */}
      <div ref={contentRef} className="flex-1 overflow-auto min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center h-full" data-testid="diff-loading">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div
            className="flex items-center justify-center h-full text-destructive"
            data-testid="diff-error"
          >
            {error}
          </div>
        )}

        {!isLoading && !error && isNewFile && fileContent !== null ? (
          <div className="overflow-auto flex-1" data-testid="plain-file-content">
            <SyntaxHighlighter
              language={getLanguageFromPath(filePath)}
              style={oneDark}
              showLineNumbers
              wrapLines
              customStyle={{
                margin: 0,
                borderRadius: 0,
                fontSize: '12px',
                lineHeight: '20px',
                background: 'transparent',
                minHeight: '100%'
              }}
              codeTagProps={{
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
                }
              }}
            >
              {fileContent}
            </SyntaxHighlighter>
          </div>
        ) : (
          !isLoading &&
          !error && (
            <DiffViewer
              diff={diff}
              viewMode={viewMode}
              className={cn(viewMode === 'split' && 'min-w-[800px]')}
            />
          )
        )}
      </div>
    </div>
  )
}
