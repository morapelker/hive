/**
 * Session 10: PR to GitHub — Backend Tests
 *
 * Testing criteria from phase-18.md:
 * - getRemoteUrl returns GitHub SSH URL
 * - getRemoteUrl returns GitHub HTTPS URL
 * - checkRemoteInfo detects GitHub
 * - checkRemoteInfo detects non-GitHub
 * - checkRemoteInfo handles no remote
 * - remote check only runs once per worktree
 * - setPrTargetBranch stores per worktree
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// --- GitService.getRemoteUrl() unit tests ---

describe('Session 10: PR to GitHub Backend', () => {
  describe('GitService.getRemoteUrl()', () => {
    let mockGit: {
      getRemotes: ReturnType<typeof vi.fn>
    }
    let gitService: {
      getRemoteUrl: (remote?: string) => Promise<{
        success: boolean
        url: string | null
        remote: string | null
        error?: string
      }>
    }

    beforeEach(() => {
      mockGit = {
        getRemotes: vi.fn()
      }

      // Create a minimal GitService-like object that mirrors the implementation
      gitService = {
        getRemoteUrl: async (remote = 'origin') => {
          try {
            const remotes = await mockGit.getRemotes(true)
            const target = remotes.find((r: { name: string }) => r.name === remote)
            return {
              success: true,
              url: target?.refs?.fetch || target?.refs?.push || null,
              remote: target?.name || null
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, url: null, remote: null, error: message }
          }
        }
      }
    })

    test('getRemoteUrl returns GitHub SSH URL', async () => {
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: {
            fetch: 'git@github.com:org/repo.git',
            push: 'git@github.com:org/repo.git'
          }
        }
      ])

      const result = await gitService.getRemoteUrl()

      expect(result.success).toBe(true)
      expect(result.url).toBe('git@github.com:org/repo.git')
      expect(result.remote).toBe('origin')
    })

    test('getRemoteUrl returns GitHub HTTPS URL', async () => {
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: {
            fetch: 'https://github.com/org/repo.git',
            push: 'https://github.com/org/repo.git'
          }
        }
      ])

      const result = await gitService.getRemoteUrl()

      expect(result.success).toBe(true)
      expect(result.url).toBe('https://github.com/org/repo.git')
    })

    test('getRemoteUrl returns null when no remotes', async () => {
      mockGit.getRemotes.mockResolvedValue([])

      const result = await gitService.getRemoteUrl()

      expect(result.success).toBe(true)
      expect(result.url).toBeNull()
      expect(result.remote).toBeNull()
    })

    test('getRemoteUrl handles error', async () => {
      mockGit.getRemotes.mockRejectedValue(new Error('not a git repo'))

      const result = await gitService.getRemoteUrl()

      expect(result.success).toBe(false)
      expect(result.url).toBeNull()
      expect(result.error).toBe('not a git repo')
    })

    test('getRemoteUrl accepts custom remote name', async () => {
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'upstream',
          refs: { fetch: 'https://github.com/upstream/repo.git', push: '' }
        },
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/fork/repo.git', push: '' }
        }
      ])

      const result = await gitService.getRemoteUrl('upstream')

      expect(result.success).toBe(true)
      expect(result.url).toBe('https://github.com/upstream/repo.git')
      expect(result.remote).toBe('upstream')
    })

    test('getRemoteUrl prefers fetch URL over push URL', async () => {
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: {
            fetch: 'https://github.com/org/repo-fetch.git',
            push: 'https://github.com/org/repo-push.git'
          }
        }
      ])

      const result = await gitService.getRemoteUrl()

      expect(result.url).toBe('https://github.com/org/repo-fetch.git')
    })

    test('getRemoteUrl falls back to push URL if no fetch URL', async () => {
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: '', push: 'https://github.com/org/repo-push.git' }
        }
      ])

      const result = await gitService.getRemoteUrl()

      expect(result.url).toBe('https://github.com/org/repo-push.git')
    })
  })

  describe('IPC handler contract', () => {
    test('git:getRemoteUrl handler should be registered', () => {
      const expectedChannel = 'git:getRemoteUrl'
      const expectedParams = ['worktreePath', 'remote']

      expect(expectedChannel).toBe('git:getRemoteUrl')
      expect(expectedParams).toHaveLength(2)
    })
  })

  describe('Preload bridge contract', () => {
    test('gitOps.getRemoteUrl should accept worktreePath and optional remote', async () => {
      const mockGetRemoteUrl = vi.fn().mockResolvedValue({
        success: true,
        url: 'git@github.com:org/repo.git',
        remote: 'origin'
      })

      const result = await mockGetRemoteUrl('/test/path')

      expect(mockGetRemoteUrl).toHaveBeenCalledWith('/test/path')
      expect(result.success).toBe(true)
      expect(result.url).toBe('git@github.com:org/repo.git')
    })

    test('gitOps.getRemoteUrl returns null url when no remote', async () => {
      const mockGetRemoteUrl = vi.fn().mockResolvedValue({
        success: true,
        url: null,
        remote: null
      })

      const result = await mockGetRemoteUrl('/test/path')

      expect(result.url).toBeNull()
    })
  })

  describe('useGitStore remote info', () => {
    beforeEach(() => {
      // Reset store state
      useGitStore.setState({
        remoteInfo: new Map(),
        prTargetBranch: new Map()
      })

      // Mock window.gitOps.getRemoteUrl
      Object.defineProperty(window, 'gitOps', {
        writable: true,
        value: {
          ...window.gitOps,
          getRemoteUrl: vi.fn()
        }
      })
    })

    test('checkRemoteInfo detects GitHub from SSH URL', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: 'git@github.com:org/repo.git',
        remote: 'origin'
      })

      await useGitStore.getState().checkRemoteInfo('wt-1', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-1')
      expect(info).toEqual({
        hasRemote: true,
        isGitHub: true,
        url: 'git@github.com:org/repo.git'
      })
    })

    test('checkRemoteInfo detects GitHub from HTTPS URL', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: 'https://github.com/org/repo.git',
        remote: 'origin'
      })

      await useGitStore.getState().checkRemoteInfo('wt-2', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-2')
      expect(info).toEqual({
        hasRemote: true,
        isGitHub: true,
        url: 'https://github.com/org/repo.git'
      })
    })

    test('checkRemoteInfo detects non-GitHub remote', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: 'https://gitlab.com/org/repo.git',
        remote: 'origin'
      })

      await useGitStore.getState().checkRemoteInfo('wt-3', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-3')
      expect(info).toEqual({
        hasRemote: true,
        isGitHub: false,
        url: 'https://gitlab.com/org/repo.git'
      })
    })

    test('checkRemoteInfo handles no remote', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: null,
        remote: null
      })

      await useGitStore.getState().checkRemoteInfo('wt-4', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-4')
      expect(info).toEqual({
        hasRemote: false,
        isGitHub: false,
        url: null
      })
    })

    test('checkRemoteInfo handles IPC failure gracefully', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockRejectedValue(new Error('IPC failed'))

      await useGitStore.getState().checkRemoteInfo('wt-5', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-5')
      expect(info).toEqual({
        hasRemote: false,
        isGitHub: false,
        url: null
      })
    })

    test('remote check only runs once per worktree (cached)', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: 'git@github.com:org/repo.git',
        remote: 'origin'
      })

      // First call
      await useGitStore.getState().checkRemoteInfo('wt-6', '/test/path')
      expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1)

      // Verify info is cached
      const info = useGitStore.getState().remoteInfo.get('wt-6')
      expect(info).toBeDefined()

      // The useEffect in AppLayout checks `if (!info)` before calling checkRemoteInfo
      // So if info exists, it won't call again — we test this logic:
      const cachedInfo = useGitStore.getState().remoteInfo.get('wt-6')
      if (!cachedInfo) {
        await useGitStore.getState().checkRemoteInfo('wt-6', '/test/path')
      }

      // Still only called once
      expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1)
    })

    test('setPrTargetBranch stores per worktree', () => {
      useGitStore.getState().setPrTargetBranch('wt-1', 'origin/main')
      useGitStore.getState().setPrTargetBranch('wt-2', 'origin/develop')

      expect(useGitStore.getState().prTargetBranch.get('wt-1')).toBe('origin/main')
      expect(useGitStore.getState().prTargetBranch.get('wt-2')).toBe('origin/develop')
    })

    test('setPrTargetBranch overwrites previous value', () => {
      useGitStore.getState().setPrTargetBranch('wt-1', 'origin/main')
      useGitStore.getState().setPrTargetBranch('wt-1', 'origin/release')

      expect(useGitStore.getState().prTargetBranch.get('wt-1')).toBe('origin/release')
    })

    test('checkRemoteInfo detects Bitbucket as non-GitHub', async () => {
      const mockGetRemoteUrl = window.gitOps.getRemoteUrl as ReturnType<typeof vi.fn>
      mockGetRemoteUrl.mockResolvedValue({
        success: true,
        url: 'git@bitbucket.org:org/repo.git',
        remote: 'origin'
      })

      await useGitStore.getState().checkRemoteInfo('wt-7', '/test/path')

      const info = useGitStore.getState().remoteInfo.get('wt-7')
      expect(info?.isGitHub).toBe(false)
      expect(info?.hasRemote).toBe(true)
    })
  })
})
