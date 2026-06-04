import { describe, expect, it } from 'vitest'
import { deriveProjectNameFromGitUrl } from './git-repository'

describe('deriveProjectNameFromGitUrl', () => {
  it('derives the repo name from SSH and HTTPS git URLs', () => {
    expect(deriveProjectNameFromGitUrl('git@github.com:user/repo.git')).toBe('repo')
    expect(deriveProjectNameFromGitUrl('https://github.com/user/hive-electron.git')).toBe(
      'hive-electron'
    )
    expect(deriveProjectNameFromGitUrl('ssh://git@github.com/user/nested/repo.git')).toBe(
      'repo'
    )
  })

  it('rejects URLs with no usable repository segment', () => {
    expect(deriveProjectNameFromGitUrl('')).toBeNull()
    expect(deriveProjectNameFromGitUrl('git@github.com:user/.git')).toBeNull()
    expect(deriveProjectNameFromGitUrl('https://github.com/user/')).toBeNull()
  })
})
