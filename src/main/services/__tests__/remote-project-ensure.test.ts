import { describe, expect, it } from 'vitest'

import { normalizeGitUrl } from '../remote-project-ensure'

describe('normalizeGitUrl', () => {
  it('treats scp-style, ssh and https forms of the same repo as equal', () => {
    const forms = [
      'git@github.com:org/repo.git',
      'git@github.com:org/repo',
      'ssh://git@github.com/org/repo.git',
      'https://github.com/org/repo.git',
      'https://github.com/org/repo',
      'HTTPS://GitHub.com/Org/Repo.git',
      '  git@github.com:org/repo.git  '
    ]
    for (const form of forms) {
      expect(normalizeGitUrl(form)).toBe('github.com/org/repo')
    }
  })

  it('does not conflate different repos', () => {
    expect(normalizeGitUrl('git@github.com:org/repo.git')).not.toBe(
      normalizeGitUrl('git@github.com:org/other.git')
    )
    expect(normalizeGitUrl('git@github.com:org/repo.git')).not.toBe(
      normalizeGitUrl('git@gitlab.com:org/repo.git')
    )
    expect(normalizeGitUrl('git@github.com:org/repo.git')).not.toBe(
      normalizeGitUrl('git@github.com:other/repo.git')
    )
  })

  it('strips trailing slashes before the .git suffix check', () => {
    expect(normalizeGitUrl('https://github.com/org/repo/')).toBe('github.com/org/repo')
  })
})
