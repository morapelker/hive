import type { editor, IRange } from 'monaco-editor'

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

interface LineRange {
  start: number
  end: number
}

export interface HiddenAreasInput {
  hunks: Hunk[]
  contextLines: number
  originalLineCount: number
  modifiedLineCount: number
  extraVisibleOriginal?: number[]
  extraVisibleModified?: number[]
}

export interface HiddenAreasResult {
  originalRanges: IRange[]
  modifiedRanges: IRange[]
  gaps: Array<{
    side: 'modified'
    afterLine: number
    hiddenLineCount: number
    firstHiddenOriginal: number | null
    lastHiddenOriginal: number | null
    firstHiddenModified: number
    lastHiddenModified: number
  }>
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

export function computeHiddenAreas({
  hunks,
  contextLines,
  originalLineCount,
  modifiedLineCount,
  extraVisibleOriginal = [],
  extraVisibleModified = []
}: HiddenAreasInput): HiddenAreasResult {
  if (hunks.length === 0) {
    return { originalRanges: [], modifiedRanges: [], gaps: [] }
  }

  const originalVisible: LineRange[] = []
  const modifiedVisible: LineRange[] = []

  for (const hunk of hunks) {
    addVisibleHunkRange(
      originalVisible,
      hunk.originalStartLine,
      hunk.originalEndLine,
      contextLines,
      originalLineCount
    )
    addVisibleHunkRange(
      modifiedVisible,
      hunk.modifiedStartLine,
      hunk.modifiedEndLine,
      contextLines,
      modifiedLineCount
    )
  }

  for (const line of extraVisibleOriginal) {
    addClampedRange(originalVisible, line - contextLines, line + contextLines, originalLineCount)
  }
  for (const line of extraVisibleModified) {
    addClampedRange(modifiedVisible, line - contextLines, line + contextLines, modifiedLineCount)
  }

  const originalHidden = invertRanges(mergeRanges(originalVisible), originalLineCount)
  const modifiedHidden = invertRanges(mergeRanges(modifiedVisible), modifiedLineCount)

  return {
    originalRanges: originalHidden.map(toMonacoRange),
    modifiedRanges: modifiedHidden.map(toMonacoRange),
    gaps: modifiedHidden.map((range) => {
      const originalRange = mapModifiedHiddenRangeToOriginal(range, hunks, originalLineCount)
      return {
        side: 'modified' as const,
        afterLine: range.start - 1,
        hiddenLineCount: range.end - range.start + 1,
        firstHiddenOriginal: originalRange?.start ?? null,
        lastHiddenOriginal: originalRange?.end ?? null,
        firstHiddenModified: range.start,
        lastHiddenModified: range.end
      }
    })
  }
}

function mapModifiedHiddenRangeToOriginal(
  range: LineRange,
  hunks: Hunk[],
  originalLineCount: number
): LineRange | null {
  const start = mapModifiedLineToOriginal(range.start, hunks, originalLineCount)
  const end = mapModifiedLineToOriginal(range.end, hunks, originalLineCount)

  if (start === null || end === null) {
    return null
  }

  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  }
}

function mapModifiedLineToOriginal(
  modifiedLine: number,
  hunks: Hunk[],
  originalLineCount: number
): number | null {
  let lineDelta = 0
  const sortedHunks = [...hunks].sort(
    (a, b) => a.modifiedStartLine - b.modifiedStartLine || a.modifiedEndLine - b.modifiedEndLine
  )

  for (const hunk of sortedHunks) {
    const modifiedEndLine =
      hunk.modifiedEndLine === 0 ? hunk.modifiedStartLine : hunk.modifiedEndLine

    if (modifiedLine < hunk.modifiedStartLine) {
      break
    }

    if (modifiedLine <= modifiedEndLine) {
      return null
    }

    lineDelta += getOriginalLineCount(hunk) - getModifiedLineCount(hunk)
  }

  return clampLine(modifiedLine + lineDelta, originalLineCount)
}

function getOriginalLineCount(hunk: Hunk): number {
  if (hunk.originalEndLine === 0) return 0
  return hunk.originalEndLine - hunk.originalStartLine + 1
}

function getModifiedLineCount(hunk: Hunk): number {
  if (hunk.modifiedEndLine === 0) return 0
  return hunk.modifiedEndLine - hunk.modifiedStartLine + 1
}

function clampLine(line: number, lineCount: number): number {
  if (lineCount <= 0) return 0
  return Math.max(1, Math.min(line, lineCount))
}

function addVisibleHunkRange(
  ranges: LineRange[],
  startLine: number,
  endLine: number,
  contextLines: number,
  lineCount: number
): void {
  const start = startLine
  const end = endLine === 0 ? startLine : endLine
  addClampedRange(ranges, start - contextLines, end + contextLines, lineCount)
}

function addClampedRange(ranges: LineRange[], start: number, end: number, lineCount: number): void {
  if (lineCount <= 0) return

  const clampedStart = Math.max(1, Math.min(start, lineCount))
  const clampedEnd = Math.max(1, Math.min(end, lineCount))
  if (clampedStart > clampedEnd) return

  ranges.push({ start: clampedStart, end: clampedEnd })
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: LineRange[] = [{ ...sorted[0] }]

  for (const range of sorted.slice(1)) {
    const previous = merged[merged.length - 1]
    if (range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}

function invertRanges(visibleRanges: LineRange[], lineCount: number): LineRange[] {
  if (lineCount <= 0) return []
  if (visibleRanges.length === 0) return [{ start: 1, end: lineCount }]

  const hidden: LineRange[] = []
  let cursor = 1

  for (const range of visibleRanges) {
    if (cursor < range.start) {
      hidden.push({ start: cursor, end: range.start - 1 })
    }
    cursor = range.end + 1
  }

  if (cursor <= lineCount) {
    hidden.push({ start: cursor, end: lineCount })
  }

  return hidden
}

function toMonacoRange(range: LineRange): IRange {
  return {
    startLineNumber: range.start,
    startColumn: 1,
    endLineNumber: range.end,
    endColumn: 1
  }
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

export { getMonacoLanguage } from '@/lib/language-map'
