import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { flattenTree, scoreMatch, type FlatFile, type FileTreeNode } from '@/lib/file-search-utils'

export interface FileMention {
  relativePath: string
  startIndex: number
  endIndex: number
}

export interface SelectFileResult {
  newValue: string
  newCursorPosition: number
  mention: FileMention
}

/**
 * Pure function: strips the '@' character from tracked mentions in the text.
 * Processes mentions from end to start to preserve indices.
 */
export function applyStripping(text: string, mentions: FileMention[]): string {
  if (mentions.length === 0) return text

  // Sort by startIndex descending so removals don't shift earlier indices
  const sorted = [...mentions].sort((a, b) => b.startIndex - a.startIndex)

  let result = text
  for (const mention of sorted) {
    // Verify the '@' is actually there before removing
    if (result[mention.startIndex] === '@') {
      result = result.substring(0, mention.startIndex) + result.substring(mention.startIndex + 1)
    }
  }

  return result
}

interface TriggerState {
  isOpen: boolean
  query: string
  triggerIndex: number
}

function detectTrigger(inputValue: string, cursorPosition: number): TriggerState {
  const closed: TriggerState = { isOpen: false, query: '', triggerIndex: -1 }

  // Scan backward from cursor to find nearest @
  for (let i = cursorPosition - 1; i >= 0; i--) {
    const ch = inputValue[i]

    // If we hit a space or newline before finding @, no valid trigger
    if (ch === ' ' || ch === '\n') {
      return closed
    }

    if (ch === '@') {
      // Check word boundary: @ must be at position 0 or preceded by space/newline
      if (i === 0 || inputValue[i - 1] === ' ' || inputValue[i - 1] === '\n') {
        const query = inputValue.substring(i + 1, cursorPosition)
        // If query contains a space, user abandoned the mention
        if (query.includes(' ')) {
          return closed
        }
        return { isOpen: true, query, triggerIndex: i }
      }
      // Mid-word @ — not a valid trigger
      return closed
    }
  }

  return closed
}

function filterSuggestions(flatFiles: FlatFile[], query: string): FlatFile[] {
  if (query === '') {
    // Return first 5 files alphabetically by relativePath
    return [...flatFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).slice(0, 5)
  }

  // Score and filter
  const scored = flatFiles
    .map((file) => ({ file, score: scoreMatch(query, file) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.file.relativePath.localeCompare(b.file.relativePath)
    })
    .slice(0, 5)

  return scored.map(({ file }) => file)
}

export function useFileMentions(
  inputValue: string,
  cursorPosition: number,
  fileTree: FileTreeNode[]
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentions, setMentions] = useState<FileMention[]>([])
  const prevQueryRef = useRef('')

  // Memoize flat file list — only recompute when fileTree reference changes
  const flatFiles = useMemo(() => flattenTree(fileTree), [fileTree])

  // Detect trigger
  const trigger = useMemo(
    () => detectTrigger(inputValue, cursorPosition),
    [inputValue, cursorPosition]
  )

  const { isOpen, query, triggerIndex } = trigger

  // Filter suggestions
  const suggestions = useMemo(
    () => (isOpen ? filterSuggestions(flatFiles, query) : []),
    [isOpen, flatFiles, query]
  )

  // Reset selectedIndex when query changes
  useEffect(() => {
    if (query !== prevQueryRef.current) {
      setSelectedIndex(0)
      prevQueryRef.current = query
    }
  }, [query])

  // Keyboard navigation
  const moveSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (suggestions.length === 0) return
      setSelectedIndex((prev) => {
        if (direction === 'down') {
          return (prev + 1) % suggestions.length
        }
        return (prev - 1 + suggestions.length) % suggestions.length
      })
    },
    [suggestions.length]
  )

  // Select a file — returns insertion data
  const selectFile = useCallback(
    (file: FlatFile): SelectFileResult => {
      const insertion = `@${file.relativePath} `
      const before = inputValue.substring(0, triggerIndex)
      const after = inputValue.substring(cursorPosition)
      const newValue = before + insertion + after
      const newCursorPosition = triggerIndex + insertion.length

      const mention: FileMention = {
        relativePath: file.relativePath,
        startIndex: triggerIndex,
        endIndex: triggerIndex + insertion.length - 2 // exclude trailing space
      }

      setMentions((prev) => [...prev, mention])

      return { newValue, newCursorPosition, mention }
    },
    [inputValue, triggerIndex, cursorPosition]
  )

  // For dismiss to work, we need manual override state
  const [manualDismiss, setManualDismiss] = useState(false)
  const prevTriggerRef = useRef({ isOpen: false, query: '', triggerIndex: -1 })

  // Reset manual dismiss when trigger state changes (new @ typed)
  useEffect(() => {
    const prev = prevTriggerRef.current
    if (trigger.triggerIndex !== prev.triggerIndex || trigger.query !== prev.query) {
      setManualDismiss(false)
    }
    prevTriggerRef.current = trigger
  }, [trigger])

  const effectiveIsOpen = isOpen && !manualDismiss

  const effectiveDismiss = useCallback(() => {
    setManualDismiss(true)
  }, [])

  // Recalculate suggestions with effective open state
  const effectiveSuggestions = useMemo(
    () => (effectiveIsOpen ? filterSuggestions(flatFiles, query) : []),
    [effectiveIsOpen, flatFiles, query]
  )

  // Update mention indices when the input text changes
  const updateMentions = useCallback((oldValue: string, newValue: string) => {
    if (oldValue === newValue) return

    setMentions((prev) => {
      if (prev.length === 0) return prev

      // Find the first differing character position
      let diffStart = 0
      const minLen = Math.min(oldValue.length, newValue.length)
      while (diffStart < minLen && oldValue[diffStart] === newValue[diffStart]) {
        diffStart++
      }

      const lengthDelta = newValue.length - oldValue.length

      return prev
        .map((mention) => {
          // Edit is entirely after the mention — no change needed
          if (diffStart > mention.endIndex) {
            return mention
          }

          // Edit is entirely before the mention — shift indices
          if (diffStart <= mention.startIndex) {
            const shifted: FileMention = {
              ...mention,
              startIndex: mention.startIndex + lengthDelta,
              endIndex: mention.endIndex + lengthDelta
            }

            // Validate the mention text still matches at the new position
            const expected = `@${mention.relativePath}`
            const actual = newValue.substring(shifted.startIndex, shifted.endIndex + 1)
            if (actual !== expected) return null

            return shifted
          }

          // Edit overlaps the mention range — remove it
          return null
        })
        .filter((m): m is FileMention => m !== null)
    })
  }, [])

  // Get text ready to send, optionally stripping @ from tracked mentions
  const getTextForSend = useCallback(
    (stripAtMentions: boolean): string => {
      if (stripAtMentions) {
        return applyStripping(inputValue, mentions)
      }
      return inputValue
    },
    [inputValue, mentions]
  )

  const clearMentions = useCallback(() => {
    setMentions([])
  }, [])

  return {
    isOpen: effectiveIsOpen,
    query,
    triggerIndex,
    suggestions: effectiveSuggestions,
    selectedIndex,
    mentions,
    moveSelection,
    selectFile,
    dismiss: effectiveDismiss,
    clearMentions,
    updateMentions,
    getTextForSend
  }
}
