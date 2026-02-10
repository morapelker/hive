import { useState, useMemo } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

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
  '.env': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.dockerfile': 'docker',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.clj': 'clojure',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.tf': 'hcl',
  '.proto': 'protobuf'
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore' || name === '.dockerignore') return 'bash'
  return extensionToLanguage[ext] || 'text'
}

export function WriteToolView({ input, error }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false)

  const filePath = (input.file_path || input.filePath || input.path || '') as string
  const content = (input.content || '') as string

  const language = useMemo(() => (filePath ? getLanguageFromPath(filePath) : 'text'), [filePath])

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">{error}</div>
    )
  }

  if (!content) return null

  const lines = content.split('\n')
  const needsTruncation = lines.length > MAX_PREVIEW_LINES
  const displayedContent = showAll ? content : lines.slice(0, MAX_PREVIEW_LINES).join('\n')

  return (
    <div data-testid="write-tool-view">
      {/* Syntax-highlighted code block */}
      <div className="rounded-md overflow-hidden">
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          showLineNumbers
          startingLineNumber={1}
          wrapLines
          customStyle={{
            margin: 0,
            borderRadius: '0.375rem',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '8px 0'
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: '#52525b',
            userSelect: 'none'
          }}
          codeTagProps={{
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
            }
          }}
        >
          {displayedContent}
        </SyntaxHighlighter>
      </div>

      {/* Show all button */}
      {needsTruncation && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
          data-testid="show-all-button"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-150', showAll && 'rotate-180')}
          />
          {showAll ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}
