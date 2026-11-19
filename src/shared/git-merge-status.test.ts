import { describe, expect, it } from 'vitest'
import { commitsToMerge } from './git-merge-status'

describe('commitsToMerge', () => {
  it('counts the commits the base lacks', () => {
    expect(commitsToMerge({ commitsAhead: 3, contentMerged: false })).toBe(3)
    expect(commitsToMerge({ commitsAhead: 0, contentMerged: false })).toBe(0)
  })

  it('counts none when their content is on the base already', () => {
    expect(commitsToMerge({ commitsAhead: 3, contentMerged: true })).toBe(0)
  })

  it('reads an answer without the check as the plain count', () => {
    expect(commitsToMerge({ commitsAhead: 3 })).toBe(3)
  })
})
