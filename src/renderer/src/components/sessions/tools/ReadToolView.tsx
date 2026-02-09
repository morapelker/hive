import { useState, useMemo } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

// Output format from OpenCode Read tool:
//   <file>
//   00001| line content
//   00002| line content
//   ...
//   (End of file - total N lines)
//   </file>
const LINE_PREFIX_RE = /^(\s*\d+)\s*[|│\t]\s?/

/** Parse Read tool output, stripping wrapper tags and line number prefixes */
function parseReadOutput(output: string): { content: string; startLine: number; lineCount: number } {
  let rawLines = output.split('\n')

  // Strip <file>...</file> wrapper and footer
  if (rawLines[0]?.trim() === '<file>') {
    rawLines = rawLines.slice(1)
  }
  // Remove closing </file> tag and "(End of file ...)" footer from the end
  while (rawLines.length > 0) {
    const last = rawLines[rawLines.length - 1].trim()
    if (last === '</file>' || last === '' || last.startsWith('(End of file')) {
      rawLines.pop()
    } else {
      break
    }
  }

  // Check if remaining lines have number prefixes
  const firstNonEmpty = rawLines.find(l => l.trim())
  if (!firstNonEmpty || !LINE_PREFIX_RE.test(firstNonEmpty)) {
    return { content: rawLines.join('\n'), startLine: 1, lineCount: rawLines.length }
  }

  let startLine = 1
  const contentLines: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const match = rawLines[i].match(LINE_PREFIX_RE)
    if (match) {
      if (contentLines.length === 0) startLine = parseInt(match[1], 10)
      contentLines.push(rawLines[i].slice(match[0].length))
    } else {
      contentLines.push(rawLines[i])
    }
  }

  return { content: contentLines.join('\n'), startLine, lineCount: contentLines.length }
}

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
  '.proto': 'protobuf',
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  const name = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore' || name === '.dockerignore') return 'bash'
  return extensionToLanguage[ext] || 'text'
}

export function ReadToolView({ input, output, error }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false)

  const filePath = (input.file_path || input.filePath || input.path || '') as string
  const offset = input.offset as number | undefined
  const limit = input.limit as number | undefined

  const language = useMemo(
    () => filePath ? getLanguageFromPath(filePath) : 'text',
    [filePath]
  )

  const lineRange = offset && limit
    ? `Lines ${offset}–${offset + limit}`
    : offset
      ? `From line ${offset}`
      : limit
        ? `First ${limit} lines`
        : ''

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">
        {error}
      </div>
    )
  }

  if (!output) return null

  const parsed = parseReadOutput(output)
  const lines = parsed.content.split('\n')
  const startLine = offset || parsed.startLine
  const needsTruncation = lines.length > MAX_PREVIEW_LINES
  const displayedContent = showAll
    ? parsed.content
    : lines.slice(0, MAX_PREVIEW_LINES).join('\n')

  return (
    <div data-testid="read-tool-view">
      {/* Line range info */}
      {lineRange && (
        <div className="text-muted-foreground/60 text-[10px] mb-1.5">{lineRange}</div>
      )}

      {/* Syntax-highlighted code block */}
      <div className="rounded-md overflow-hidden">
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          showLineNumbers
          startingLineNumber={startLine}
          wrapLines
          customStyle={{
            margin: 0,
            borderRadius: '0.375rem',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '8px 0',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: '#52525b',
            userSelect: 'none',
          }}
          codeTagProps={{
            style: { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' }
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
          <ChevronDown className={cn(
            'h-3 w-3 transition-transform duration-150',
            showAll && 'rotate-180'
          )} />
          {showAll
            ? 'Show less'
            : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}
