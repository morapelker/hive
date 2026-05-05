import { describe, expect, it } from 'vitest'
import { computeHiddenAreas, type Hunk } from '../diff-utils'

function modifyHunk(
  originalStartLine: number,
  originalEndLine: number,
  modifiedStartLine = originalStartLine,
  modifiedEndLine = originalEndLine
): Hunk {
  return {
    index: 0,
    originalStartLine,
    originalEndLine,
    modifiedStartLine,
    modifiedEndLine,
    type: 'modify'
  }
}

function range(startLineNumber: number, endLineNumber: number) {
  return {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: 1
  }
}

describe('computeHiddenAreas', () => {
  it('returns no hidden ranges for empty hunks', () => {
    expect(
      computeHiddenAreas({
        hunks: [],
        contextLines: 3,
        originalLineCount: 100,
        modifiedLineCount: 100
      })
    ).toEqual({ originalRanges: [], modifiedRanges: [], gaps: [] })
  })

  it('hides unchanged content before and after a single middle hunk', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(40, 42)],
      contextLines: 3,
      originalLineCount: 100,
      modifiedLineCount: 100
    })

    expect(result.originalRanges).toEqual([range(1, 36), range(46, 100)])
    expect(result.modifiedRanges).toEqual([range(1, 36), range(46, 100)])
    expect(result.gaps).toEqual([
      {
        side: 'modified',
        afterLine: 0,
        hiddenLineCount: 36,
        firstHiddenOriginal: 1,
        lastHiddenOriginal: 36,
        firstHiddenModified: 1,
        lastHiddenModified: 36
      },
      {
        side: 'modified',
        afterLine: 45,
        hiddenLineCount: 55,
        firstHiddenOriginal: 46,
        lastHiddenOriginal: 100,
        firstHiddenModified: 46,
        lastHiddenModified: 100
      }
    ])
  })

  it('keeps the top of the file visible when hunk context reaches line one', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(2, 4)],
      contextLines: 3,
      originalLineCount: 50,
      modifiedLineCount: 50
    })

    expect(result.originalRanges).toEqual([range(8, 50)])
    expect(result.modifiedRanges).toEqual([range(8, 50)])
  })

  it('keeps the bottom of the file visible when hunk context reaches the end', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(47, 49)],
      contextLines: 3,
      originalLineCount: 50,
      modifiedLineCount: 50
    })

    expect(result.originalRanges).toEqual([range(1, 43)])
    expect(result.modifiedRanges).toEqual([range(1, 43)])
  })

  it('merges adjacent hunks when their context overlaps', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(20, 22), modifyHunk(25, 27)],
      contextLines: 3,
      originalLineCount: 60,
      modifiedLineCount: 60
    })

    expect(result.modifiedRanges).toEqual([range(1, 16), range(31, 60)])
    expect(result.gaps.map((gap) => [gap.firstHiddenModified, gap.lastHiddenModified])).toEqual([
      [1, 16],
      [31, 60]
    ])
  })

  it('uses the original anchor for pure addition hunks', () => {
    const result = computeHiddenAreas({
      hunks: [
        {
          index: 0,
          originalStartLine: 20,
          originalEndLine: 0,
          modifiedStartLine: 21,
          modifiedEndLine: 24,
          type: 'add'
        }
      ],
      contextLines: 3,
      originalLineCount: 80,
      modifiedLineCount: 84
    })

    expect(result.originalRanges).toEqual([range(1, 16), range(24, 80)])
    expect(result.modifiedRanges).toEqual([range(1, 17), range(28, 84)])
  })

  it('uses the modified anchor for pure deletion hunks', () => {
    const result = computeHiddenAreas({
      hunks: [
        {
          index: 0,
          originalStartLine: 21,
          originalEndLine: 24,
          modifiedStartLine: 20,
          modifiedEndLine: 0,
          type: 'delete'
        }
      ],
      contextLines: 3,
      originalLineCount: 84,
      modifiedLineCount: 80
    })

    expect(result.originalRanges).toEqual([range(1, 17), range(28, 84)])
    expect(result.modifiedRanges).toEqual([range(1, 16), range(24, 80)])
  })

  it('keeps extra visible modified lines and splits gaps around them', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(40, 42)],
      contextLines: 3,
      originalLineCount: 100,
      modifiedLineCount: 100,
      extraVisibleModified: [70]
    })

    expect(result.modifiedRanges).toEqual([range(1, 36), range(46, 66), range(74, 100)])
    expect(result.gaps.map((gap) => [gap.firstHiddenModified, gap.lastHiddenModified])).toEqual([
      [1, 36],
      [46, 66],
      [74, 100]
    ])
  })

  it('does not change hidden ranges when extra visible line is already in context', () => {
    const withoutExtra = computeHiddenAreas({
      hunks: [modifyHunk(40, 42)],
      contextLines: 3,
      originalLineCount: 100,
      modifiedLineCount: 100
    })
    const withExtra = computeHiddenAreas({
      hunks: [modifyHunk(40, 42)],
      contextLines: 3,
      originalLineCount: 100,
      modifiedLineCount: 100,
      extraVisibleModified: [41]
    })

    expect(withExtra.modifiedRanges).toEqual(withoutExtra.modifiedRanges)
    expect(withExtra.gaps).toEqual(withoutExtra.gaps)
  })

  it('keeps user-expanded modified ranges visible', () => {
    const result = computeHiddenAreas({
      hunks: [modifyHunk(40, 42)],
      contextLines: 3,
      originalLineCount: 100,
      modifiedLineCount: 100,
      extraVisibleModified: Array.from({ length: 24 }, (_, index) => 46 + index)
    })

    expect(result.modifiedRanges).toEqual([range(1, 36), range(73, 100)])
    expect(result.gaps.map((gap) => [gap.firstHiddenModified, gap.lastHiddenModified])).toEqual([
      [1, 36],
      [73, 100]
    ])
  })
})
