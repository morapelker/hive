import { useState, useEffect, useCallback, useRef } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Loader2 } from 'lucide-react'
import { FileSearch, type SearchMatch } from './FileSearch'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
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

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  return ext === '.md' || ext === '.mdx'
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  // Check special filenames
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore' || name === '.dockerignore') return 'bash'

  return extensionToLanguage[ext] || 'text'
}

interface FileViewerProps {
  filePath: string
}

export function FileViewer({ filePath }: FileViewerProps): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [highlightLines, setHighlightLines] = useState<Set<number>>(new Set())
  const [currentMatchLine, setCurrentMatchLine] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const isMarkdown = isMarkdownFile(filePath)
  const [viewMode, setViewMode] = useState<'preview' | 'source'>(isMarkdown ? 'preview' : 'source')

  // Load file content
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    setContent(null)
    setSearchOpen(false)
    setHighlightLines(new Set())
    setCurrentMatchLine(null)

    window.fileOps.readFile(filePath).then((result) => {
      if (cancelled) return
      if (result.success && result.content !== undefined) {
        setContent(result.content)
      } else {
        setError(result.error || 'Failed to read file')
      }
      setIsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [filePath])

  // Reset view mode when file changes
  useEffect(() => {
    setViewMode(isMarkdownFile(filePath) ? 'preview' : 'source')
  }, [filePath])

  // Cmd+F keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  const handleMatchesChange = useCallback((matches: SearchMatch[], currentIndex: number) => {
    const lines = new Set<number>()
    for (const m of matches) {
      lines.add(m.line)
    }
    setHighlightLines(lines)

    if (matches.length > 0 && matches[currentIndex]) {
      const matchLine = matches[currentIndex].line
      setCurrentMatchLine(matchLine)

      // Scroll to the current match line
      const container = containerRef.current
      if (container) {
        // Each line in the syntax highlighter is approximately 20px
        const lineHeight = 20
        const targetScroll = matchLine * lineHeight - container.clientHeight / 2
        container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
      }
    } else {
      setCurrentMatchLine(null)
    }
  }, [])

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false)
    setHighlightLines(new Set())
    setCurrentMatchLine(null)
  }, [])

  const language = getLanguageFromPath(filePath)

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center" data-testid="file-viewer-loading">
        <div className="text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground mt-2">Loading file...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center" data-testid="file-viewer-error">
        <div className="text-center text-destructive">
          <p className="text-sm font-medium">Error loading file</p>
          <p className="text-xs mt-1 opacity-75">{error}</p>
        </div>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No content</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="file-viewer">
      {/* File path bar */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="truncate">{filePath}</span>
        {isMarkdown && (
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              onClick={() => setViewMode('source')}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                viewMode === 'source' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
              )}
              data-testid="source-toggle"
            >
              Source
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                viewMode === 'preview' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
              )}
              data-testid="preview-toggle"
            >
              Preview
            </button>
          </div>
        )}
      </div>

      {/* Search overlay */}
      {searchOpen && (
        <FileSearch
          content={content}
          onMatchesChange={handleMatchesChange}
          onClose={handleCloseSearch}
        />
      )}

      {/* Content area */}
      {viewMode === 'preview' && isMarkdown ? (
        <div
          className="flex-1 overflow-auto p-6 prose prose-sm dark:prose-invert max-w-none"
          data-testid="file-viewer-markdown-preview"
        >
          <MarkdownRenderer content={content} />
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-auto" data-testid="file-viewer-content">
          <SyntaxHighlighter
            language={language}
            style={oneDark}
            showLineNumbers
            wrapLines
            lineProps={(lineNumber: number) => {
              const lineIndex = lineNumber - 1 // lineNumber is 1-based
              const style: React.CSSProperties = {}
              if (highlightLines.has(lineIndex)) {
                style.backgroundColor = 'rgba(255, 200, 0, 0.15)'
              }
              if (currentMatchLine === lineIndex) {
                style.backgroundColor = 'rgba(255, 200, 0, 0.3)'
              }
              return { style }
            }}
            customStyle={{
              margin: 0,
              borderRadius: 0,
              fontSize: '13px',
              lineHeight: '20px',
              minHeight: '100%'
            }}
            codeTagProps={{
              style: {
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
              }
            }}
          >
            {content}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  )
}
