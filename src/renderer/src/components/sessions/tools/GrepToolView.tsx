import { useState } from 'react'
import { Search, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

export function GrepToolView({ input, output, error }: ToolViewProps) {
  const [showAll, setShowAll] = useState(false)

  const pattern = (input.pattern || input.query || input.regex || '') as string
  const searchPath = (input.path || '.') as string

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">{error}</div>
    )
  }

  if (!output) return null

  const lines = output.split('\n').filter((l) => l.trim())
  const matchCount = lines.length
  const needsTruncation = lines.length > MAX_PREVIEW_LINES
  const displayedLines = showAll ? lines : lines.slice(0, MAX_PREVIEW_LINES)

  return (
    <div data-testid="grep-tool-view">
      {/* Header */}
      <div className="flex items-center gap-1.5 text-muted-foreground mb-2">
        <Search className="h-3.5 w-3.5" />
        <span className="text-xs">
          <span className="font-mono font-medium text-foreground">&quot;{pattern}&quot;</span> in{' '}
          <span className="font-mono">{searchPath}</span>
          {matchCount > 0 && (
            <span className="ml-1">
              ({matchCount} {matchCount === 1 ? 'match' : 'matches'})
            </span>
          )}
        </span>
      </div>

      {/* Separator */}
      <div className="border-t border-border mb-2" />

      {/* Match results */}
      <div className="font-mono text-xs overflow-x-auto">
        {displayedLines.map((line, i) => {
          // Highlight the matched pattern in the line
          const parts = pattern ? splitByPattern(line, pattern) : [{ text: line, isMatch: false }]
          return (
            <div key={i} className="flex hover:bg-muted/30 py-px">
              <span className="whitespace-pre-wrap break-all text-muted-foreground">
                {parts.map((part, j) =>
                  part.isMatch ? (
                    <span key={j} className="text-yellow-500 bg-yellow-500/15 font-medium">
                      {part.text}
                    </span>
                  ) : (
                    <span key={j}>{part.text}</span>
                  )
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* No matches */}
      {matchCount === 0 && (
        <div className="text-muted-foreground text-xs italic">No matches found</div>
      )}

      {/* Show all button */}
      {needsTruncation && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1 mt-2 text-blue-500 hover:text-blue-400 text-xs font-medium transition-colors"
          data-testid="show-all-button"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-150', showAll && 'rotate-180')}
          />
          {showAll ? 'Show less' : `Show all ${lines.length} results`}
        </button>
      )}
    </div>
  )
}

/** Split text by pattern for highlighting, case-insensitive */
function splitByPattern(text: string, pattern: string): Array<{ text: string; isMatch: boolean }> {
  if (!pattern) return [{ text, isMatch: false }]

  const parts: Array<{ text: string; isMatch: boolean }> = []
  const lowerText = text.toLowerCase()
  const lowerPattern = pattern.toLowerCase()
  let lastIndex = 0

  let index = lowerText.indexOf(lowerPattern, lastIndex)
  while (index !== -1) {
    if (index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, index), isMatch: false })
    }
    parts.push({ text: text.slice(index, index + pattern.length), isMatch: true })
    lastIndex = index + pattern.length
    index = lowerText.indexOf(lowerPattern, lastIndex)
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMatch: false })
  }

  return parts.length > 0 ? parts : [{ text, isMatch: false }]
}
