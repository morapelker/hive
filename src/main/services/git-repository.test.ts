import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cloneRepository,
  deriveProjectNameFromGitUrl,
  isSafeGitRemoteUrl,
  normalizeGitRemoteUrl
} from './git-repository'

const simpleGitMock = vi.hoisted(() => ({
  clone: vi.fn(),
  env: vi.fn()
}))

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    env: simpleGitMock.env,
    clone: simpleGitMock.clone
  }))
}))

beforeEach(() => {
  simpleGitMock.clone.mockReset()
  simpleGitMock.clone.mockResolvedValue(undefined)
  simpleGitMock.env.mockReset()
  simpleGitMock.env.mockReturnValue({
    clone: simpleGitMock.clone
  })
})

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

describe('isSafeGitRemoteUrl', () => {
  it('allows supported remote URL forms', () => {
    expect(isSafeGitRemoteUrl('https://github.com/u/r.git')).toBe(true)
    expect(isSafeGitRemoteUrl('git@github.com:u/r.git')).toBe(true)
    expect(isSafeGitRemoteUrl('ssh://git@github.com/u/r.git')).toBe(true)
    expect(isSafeGitRemoteUrl('http://github.com/u/r.git')).toBe(true)
    expect(isSafeGitRemoteUrl('git://github.com/u/r.git')).toBe(true)
    expect(isSafeGitRemoteUrl('https://[::1]/u/r.git')).toBe(true)
  })

  it('rejects unsupported or unsafe URL forms', () => {
    expect(isSafeGitRemoteUrl("ext::sh -c 'id'")).toBe(false)
    expect(isSafeGitRemoteUrl('fd::1')).toBe(false)
    expect(isSafeGitRemoteUrl('file:///etc/x')).toBe(false)
    expect(isSafeGitRemoteUrl('-uplo')).toBe(false)
    expect(isSafeGitRemoteUrl('--upload-pack=x')).toBe(false)
    expect(isSafeGitRemoteUrl('')).toBe(false)
    expect(isSafeGitRemoteUrl('https://github.com/u/r with-space.git')).toBe(false)
  })
})

describe('normalizeGitRemoteUrl', () => {
  it('normalizes scp-like syntax to host/org/repo', () => {
    expect(normalizeGitRemoteUrl('git@github.com:acme/hive.git')).toBe('github.com/acme/hive')
  })

  it('normalizes https URLs, with and without .git / trailing slash', () => {
    expect(normalizeGitRemoteUrl('https://github.com/acme/hive')).toBe('github.com/acme/hive')
    expect(normalizeGitRemoteUrl('https://github.com/acme/hive.git')).toBe('github.com/acme/hive')
    expect(normalizeGitRemoteUrl('https://github.com/acme/hive.git/')).toBe(
      'github.com/acme/hive'
    )
  })

  it('strips userinfo from https URLs', () => {
    expect(normalizeGitRemoteUrl('https://user@github.com/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
    expect(normalizeGitRemoteUrl('https://user:pass@github.com/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
  })

  it('normalizes ssh:// URLs without an explicit port', () => {
    expect(normalizeGitRemoteUrl('ssh://git@github.com/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
  })

  it('drops the port from ssh:// URLs when it is the standard port 22', () => {
    expect(normalizeGitRemoteUrl('ssh://git@GitHub.com:22/acme/hive')).toBe(
      'github.com/acme/hive'
    )
  })

  it('keeps a non-standard port for ssh:// URLs', () => {
    expect(normalizeGitRemoteUrl('ssh://git@github.com:2222/acme/hive.git')).toBe(
      'github.com:2222/acme/hive'
    )
  })

  it('drops the port from https:// URLs when it is the standard port 443', () => {
    expect(normalizeGitRemoteUrl('https://github.com:443/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
  })

  it('keeps a non-standard port for https:// URLs', () => {
    expect(normalizeGitRemoteUrl('https://github.com:8443/acme/hive.git')).toBe(
      'github.com:8443/acme/hive'
    )
  })

  it('drops the port from http:// URLs when it is the standard port 80', () => {
    expect(normalizeGitRemoteUrl('http://github.com:80/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
  })

  it('drops the port from git:// URLs when it is the standard port 9418', () => {
    expect(normalizeGitRemoteUrl('git://github.com:9418/acme/hive.git')).toBe(
      'github.com/acme/hive'
    )
  })

  it('normalizes plain git:// URLs', () => {
    expect(normalizeGitRemoteUrl('git://github.com/acme/hive.git')).toBe('github.com/acme/hive')
  })

  it('lowercases the host but preserves path case', () => {
    expect(normalizeGitRemoteUrl('https://github.com/Acme/Hive')).toBe('github.com/Acme/Hive')
  })

  it('treats all equivalent forms of the same repo as equal', () => {
    const forms = [
      'git@github.com:acme/hive.git',
      'https://github.com/acme/hive',
      'https://github.com/acme/hive.git/',
      'ssh://git@github.com/acme/hive.git',
      'ssh://git@GitHub.com:22/acme/hive'
    ]

    const normalized = forms.map((url) => normalizeGitRemoteUrl(url))
    expect(new Set(normalized).size).toBe(1)
    expect(normalized[0]).toBe('github.com/acme/hive')
  })

  it('returns null for null, undefined, empty, or whitespace-only input', () => {
    expect(normalizeGitRemoteUrl(null)).toBeNull()
    expect(normalizeGitRemoteUrl(undefined)).toBeNull()
    expect(normalizeGitRemoteUrl('')).toBeNull()
    expect(normalizeGitRemoteUrl('   ')).toBeNull()
  })

  it('does not throw on unparseable/garbage input', () => {
    expect(() => normalizeGitRemoteUrl('not a url at all')).not.toThrow()
    expect(normalizeGitRemoteUrl('not a url at all')).toBe('not a url at all')
    expect(() => normalizeGitRemoteUrl('::::')).not.toThrow()
  })
})

describe('cloneRepository', () => {
  it('refuses an unsafe remote URL before invoking git', async () => {
    const result = await cloneRepository("ext::sh -c 'id'", '/tmp/x')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Refusing to clone unsupported/unsafe git URL')
    expect(simpleGitMock.env).not.toHaveBeenCalled()
    expect(simpleGitMock.clone).not.toHaveBeenCalled()
  })

  it('refuses exploit URL forms without creating command side effects', async () => {
    const marker = '/tmp/hive_pwned'
    rmSync(marker, { force: true })
    const destDir = await mkdtemp(join(tmpdir(), 'hive-clone-reject-'))

    const malicious = await cloneRepository("ext::sh -c 'touch /tmp/hive_pwned'", destDir)
    const fileUrl = await cloneRepository('file:///etc/passwd', destDir)
    const dashUrl = await cloneRepository('--upload-pack=x', destDir)
    const fdUrl = await cloneRepository('fd::1', destDir)

    expect(malicious.success).toBe(false)
    expect(fileUrl.success).toBe(false)
    expect(dashUrl.success).toBe(false)
    expect(fdUrl.success).toBe(false)
    expect(simpleGitMock.env).not.toHaveBeenCalled()
    expect(simpleGitMock.clone).not.toHaveBeenCalled()
    expect(existsSync(marker)).toBe(false)
  })

  it('passes allowed remotes to git with protocol and argument hardening', async () => {
    const result = await cloneRepository('https://github.com/octocat/Hello-World.git', '/tmp/x')

    expect(result.success).toBe(true)
    expect(simpleGitMock.env).toHaveBeenCalledWith({
      ...process.env,
      GIT_ALLOW_PROTOCOL: 'https:http:ssh:git'
    })
    expect(simpleGitMock.clone).toHaveBeenCalledWith(
      'https://github.com/octocat/Hello-World.git',
      '/tmp/x',
      ['--']
    )
  })
})
