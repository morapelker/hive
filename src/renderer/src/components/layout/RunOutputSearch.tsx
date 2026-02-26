import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { stripAnsi } from '@/lib/ansi-utils'
import type { OutputRingBuffer } from '@/lib/output-ring-buffer'

export interface RunSearchMatch {
  /** The line index in the ring buffer (as returned by buffer.get(index)) */
  lineIndex: number
  /** Character start offset in the stripped-ANSI plain text */
  matchStart: number
  /** Character end offset in the stripped-ANSI plain text */
  matchEnd: number
}

interface RunOutputSearchProps {
  /** The ring buffer to search through */
  buffer: OutputRingBuffer
  /** Version counter — triggers re-search when output changes */
  outputVersion: number
  /** Callback reporting all matches and current match index */
  onMatchesChange: (matches: RunSearchMatch[], currentIndex: number) => void
  /** Callback to close the search bar */
  onClose: () => void
}

function searchBuffer(
  buffer: OutputRingBuffer,
  query: string
): RunSearchMatch[] {
  if (!query) return []

  const lowerQuery = query.toLowerCase()
  const found: RunSearchMatch[] = []

  for (let i = 0; i < buffer.renderCount; i++) {
    const line = buffer.get(i)
    if (line === null) continue
    // Skip marker lines
    if (line.startsWith('\x00')) continue

    const plainText = stripAnsi(line).toLowerCase()
    let startPos = 0
    while (true) {
      const idx = plainText.indexOf(lowerQuery, startPos)
      if (idx === -1) break
      found.push({
        lineIndex: i,
        matchStart: idx,
        matchEnd: idx + query.length
      })
      startPos = idx + 1
    }
  }

  return found
}

export function RunOutputSearch({
  buffer,
  outputVersion,
  onMatchesChange,
  onClose
}: RunOutputSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<RunSearchMatch[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced search when query or outputVersion changes
  useEffect(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
    }

    if (!query) {
      setMatches([])
      setCurrentIndex(0)
      onMatchesChange([], 0)
      return
    }

    debounceRef.current = setTimeout(() => {
      const found = searchBuffer(buffer, query)
      setMatches(found)
      const newIndex = 0
      setCurrentIndex(newIndex)
      onMatchesChange(found, newIndex)
    }, 150)

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [query, outputVersion, buffer, onMatchesChange])

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
        placeholder="Find in output..."
        className="flex-1 bg-input border border-border rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring min-w-0"
        data-testid="run-search-input"
      />
      <span
        className="text-xs text-muted-foreground whitespace-nowrap"
        data-testid="run-search-count"
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
        data-testid="run-search-prev"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => goToMatch(currentIndex + 1)}
        disabled={matches.length === 0}
        className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
        title="Next match (Enter)"
        data-testid="run-search-next"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-accent transition-colors"
        title="Close (Escape)"
        data-testid="run-search-close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
