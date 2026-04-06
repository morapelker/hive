import { describe, expect, test } from 'vitest'
import { PR_URL_PATTERN } from '../../../src/renderer/src/hooks/usePRDetection'

describe('Session 4: PR detection hook patterns', () => {
  test('matches standard GitHub PR URLs', () => {
    const match = 'https://github.com/myorg/myrepo/pull/42'.match(PR_URL_PATTERN)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('42')
  })

  test('extracts number from URL embedded in text', () => {
    const text = 'Created PR: https://github.com/org/repo/pull/123 successfully'
    const match = text.match(PR_URL_PATTERN)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('123')
  })

  test('does not match non-GitHub URLs', () => {
    expect('https://gitlab.com/org/repo/pull/42'.match(PR_URL_PATTERN)).toBeNull()
  })

  test('does not match GitHub URLs without /pull/ path', () => {
    expect('https://github.com/org/repo/issues/42'.match(PR_URL_PATTERN)).toBeNull()
  })

  test('matches PR URL with large number', () => {
    const match = 'https://github.com/org/repo/pull/99999'.match(PR_URL_PATTERN)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('99999')
  })

  test('matches PR URL in markdown link', () => {
    const text = '[PR #42](https://github.com/org/repo/pull/42)'
    const match = text.match(PR_URL_PATTERN)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('42')
  })

  test('matches PR URL with complex org/repo names', () => {
    const match = 'https://github.com/my-org/my-repo.js/pull/7'.match(PR_URL_PATTERN)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('7')
  })

  test('does not match partial URLs', () => {
    expect('github.com/org/repo/pull/42'.match(PR_URL_PATTERN)).toBeNull()
  })
})
