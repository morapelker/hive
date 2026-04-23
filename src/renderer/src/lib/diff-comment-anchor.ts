export interface ReanchorResult {
  id: string
  line_start: number
  line_end: number | null
  is_outdated: boolean
}

/**
 * Score stored context against actual context extracted from the model.
 *
 * Compares up to 3 lines from the boundary inward. Returns 0 (perfect match)
 * to 3 (no match). Null stored context returns 0 (no penalty).
 */
function scoreContext(stored: string | null, actual: string): number {
  if (stored === null) return 0

  const storedLines = stored.split('\n')
  const actualLines = actual.split('\n')

  // Compare only lines present in both stored and actual context.
  // Near file boundaries, actual context may have fewer lines — comparing
  // against null would unfairly penalize candidates near edges.
  const compareCount = Math.min(storedLines.length, actualLines.length, 3)
  let score = 0
  for (let i = 0; i < compareCount; i++) {
    if (storedLines[i] !== actualLines[i]) score++
  }
  return score
}

/**
 * Re-anchor a set of diff comments against the current model content.
 *
 * For each comment, attempts to find the stored anchor_text in the model.
 * Returns updated line positions and an is_outdated flag for each comment.
 *
 * @param comments - The comments to re-anchor
 * @param getLineContent - Returns the content of a 1-based line number
 * @param lineCount - Total number of lines in the model
 */
export function reanchorComments(
  comments: DiffComment[],
  getLineContent: (lineNumber: number) => string,
  lineCount: number
): ReanchorResult[] {
  return comments.map((comment) => {
    const { id, line_start, line_end, anchor_text } = comment

    // 1. Skip guard — no anchor text, preserve positions, not outdated
    if (!anchor_text) {
      return { id, line_start, line_end, is_outdated: false }
    }

    const anchorLines = anchor_text.split('\n')
    const anchorLineCount = anchorLines.length
    const effectiveEnd = line_end ?? line_start

    // 2. Fast path — check if anchor still matches at original position
    if (line_start >= 1 && effectiveEnd <= lineCount) {
      const currentLines: string[] = []
      for (let i = line_start; i <= effectiveEnd; i++) {
        currentLines.push(getLineContent(i))
      }
      const currentText = currentLines.join('\n')
      if (currentText === anchor_text) {
        return { id, line_start, line_end, is_outdated: false }
      }
    }

    // 3. Content scan — find all positions where anchor_text matches
    const candidateStarts: number[] = []

    if (lineCount < anchorLineCount) {
      // Not enough lines in the model to fit the anchor
      return { id, line_start, line_end: line_end, is_outdated: true }
    }

    if (anchorLineCount === 1) {
      // Single-line anchor: scan each line for an exact match
      for (let i = 1; i <= lineCount; i++) {
        if (getLineContent(i) === anchor_text) {
          candidateStarts.push(i)
        }
      }
    } else {
      // Multi-line anchor: check each candidate start position
      const maxStart = lineCount - anchorLineCount + 1
      for (let i = 1; i <= maxStart; i++) {
        let matches = true
        for (let j = 0; j < anchorLineCount; j++) {
          if (getLineContent(i + j) !== anchorLines[j]) {
            matches = false
            break
          }
        }
        if (matches) {
          candidateStarts.push(i)
        }
      }
    }

    // 4. Disambiguate
    if (candidateStarts.length === 0) {
      return { id, line_start, line_end, is_outdated: true }
    }

    let winnerStart: number
    if (candidateStarts.length === 1) {
      winnerStart = candidateStarts[0]
    } else {
      // Score each candidate by context match quality, break ties by proximity
      let bestStart = candidateStarts[0]
      let bestScore = Infinity

      for (const candidateStart of candidateStarts) {
        const candidateEnd = candidateStart + anchorLineCount - 1

        // Extract up to 3 lines of context before the candidate
        const beforeLines: string[] = []
        for (let i = Math.max(1, candidateStart - 3); i < candidateStart; i++) {
          beforeLines.push(getLineContent(i))
        }
        const actualBefore = beforeLines.join('\n')

        // Extract up to 3 lines of context after the candidate
        const afterLines: string[] = []
        for (let i = candidateEnd + 1; i <= Math.min(lineCount, candidateEnd + 3); i++) {
          afterLines.push(getLineContent(i))
        }
        const actualAfter = afterLines.join('\n')

        const score =
          scoreContext(comment.anchor_context_before, actualBefore) +
          scoreContext(comment.anchor_context_after, actualAfter)

        const proximity = Math.abs(candidateStart - line_start)
        const prevProximity = Math.abs(bestStart - line_start)

        if (score < bestScore || (score === bestScore && proximity < prevProximity)) {
          bestScore = score
          bestStart = candidateStart
        }
      }

      winnerStart = bestStart
    }

    // 5. Emit result
    const newStart = winnerStart
    const newEnd = line_end !== null ? winnerStart + anchorLineCount - 1 : null

    return { id, line_start: newStart, line_end: newEnd, is_outdated: false }
  })
}
