import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

interface SearchMatch {
  line: number // 0-based line index
  startCol: number
  endCol: number
}

interface FileSearchProps {
  content: string
  onMatchesChange: (matches: SearchMatch[], currentIndex: number) => void
  onClose: () => void
}

export type { SearchMatch }

export function FileSearch({
  content,
  onMatchesChange,
  onClose
}: FileSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Find matches when query or content changes
  useEffect(() => {
    if (!query || query.length === 0) {
      setMatches([])
      setCurrentIndex(0)
      onMatchesChange([], 0)
      return
    }

    const lines = content.split('\n')
    const found: SearchMatch[] = []
    const lowerQuery = query.toLowerCase()

    for (let i = 0; i < lines.length; i++) {
      const lowerLine = lines[i].toLowerCase()
      let startPos = 0
      while (true) {
        const idx = lowerLine.indexOf(lowerQuery, startPos)
        if (idx === -1) break
        found.push({ line: i, startCol: idx, endCol: idx + query.length })
        startPos = idx + 1
      }
    }

    setMatches(found)
    const newIndex = found.length > 0 ? 0 : 0
    setCurrentIndex(newIndex)
    onMatchesChange(found, newIndex)
  }, [query, content, onMatchesChange])

  const goToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) return
      const wrapped = ((index % matches.length) + matches.length) % matches.length
      setCurrentIndex(wrapped)
      onMatchesChange(matches, wrapped)
    },
    [matches, onMatchesChange]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        goToMatch(currentIndex - 1)
      } else {
        goToMatch(currentIndex + 1)
      }
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in file..."
        className="flex-1 bg-input border border-border rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring min-w-0"
        data-testid="file-search-input"
      />
      <span
        className="text-xs text-muted-foreground whitespace-nowrap"
        data-testid="file-search-count"
      >
        {matches.length > 0
          ? `${currentIndex + 1} of ${matches.length}`
          : query
            ? 'No results'
            : ''}
      </span>
      <button
        onClick={() => goToMatch(currentIndex - 1)}
        disabled={matches.length === 0}
        className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
        title="Previous match (Shift+Enter)"
        data-testid="file-search-prev"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => goToMatch(currentIndex + 1)}
        disabled={matches.length === 0}
        className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
        title="Next match (Enter)"
        data-testid="file-search-next"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-accent transition-colors"
        title="Close (Escape)"
        data-testid="file-search-close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
