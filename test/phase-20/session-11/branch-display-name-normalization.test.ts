import { describe, test, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

import { normalizeBranchDisplayName } from '../../../src/main/services/git-service'

describe('Session 11: Branch display name normalization', () => {
  test('strips remotes/ prefix from remote branch names', () => {
    expect(normalizeBranchDisplayName('remotes/origin/main')).toBe('origin/main')
  })

  test('preserves local branch names', () => {
    expect(normalizeBranchDisplayName('main')).toBe('main')
  })

  test('handles non-origin remotes', () => {
    expect(normalizeBranchDisplayName('remotes/upstream/feature-x')).toBe('upstream/feature-x')
  })
})
