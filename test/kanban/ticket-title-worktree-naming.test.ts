import { describe, test, expect, vi } from 'vitest'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

import { canonicalizeTicketTitle } from '../../src/main/services/git-service'

describe('canonicalizeTicketTitle', () => {
  test('converts a normal title to a branch-safe name', () => {
    expect(canonicalizeTicketTitle('Add dark mode toggle')).toBe('add-dark-mode-toggle')
  })

  test('uses the full title, not just first 3 words', () => {
    expect(canonicalizeTicketTitle('Add user authentication with OAuth2')).toBe(
      'add-user-authentication-with-oau'
    )
  })

  test('replaces spaces and underscores with dashes', () => {
    expect(canonicalizeTicketTitle('fix_login page issue')).toBe('fix-login-page-issue')
  })

  test('removes special characters', () => {
    expect(canonicalizeTicketTitle('Fix bug #123 (urgent!)')).toBe('fix-bug-123-urgent')
  })

  test('collapses consecutive dashes', () => {
    expect(canonicalizeTicketTitle('fix -- some -- thing')).toBe('fix-some-thing')
  })

  test('strips leading and trailing dashes', () => {
    expect(canonicalizeTicketTitle('--fix something--')).toBe('fix-something')
  })

  test('truncates to 32 characters', () => {
    const longTitle = 'this is a very long ticket title that exceeds fifty characters by a lot'
    const result = canonicalizeTicketTitle(longTitle)
    expect(result.length).toBeLessThanOrEqual(32)
    expect(result).not.toMatch(/-$/) // no trailing dash after truncation
  })

  test('returns empty string for emoji-only title', () => {
    expect(canonicalizeTicketTitle('🔥🚀💥')).toBe('')
  })

  test('returns empty string for special-char-only title', () => {
    expect(canonicalizeTicketTitle('!!! ???')).toBe('')
  })

  test('handles whitespace-only title', () => {
    expect(canonicalizeTicketTitle('   ')).toBe('')
  })

  test('removes slashes but preserves dots for worktree-safe names', () => {
    expect(canonicalizeTicketTitle('feature/add login.page')).toBe('featureadd-login.page')
  })
})
