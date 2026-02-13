import { describe, test, expect, beforeEach, vi } from 'vitest'
import { PR_URL_PATTERN } from '../../../src/renderer/src/hooks/usePRDetection'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// Mock useWorktreeStore (required by useGitStore internals)
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

describe('Session 4: PR Detection Hook', () => {
  beforeEach(() => {
    useGitStore.setState({
      prInfo: new Map()
    })
  })

  describe('PR_URL_PATTERN', () => {
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

  describe('PR state transition logic', () => {
    test('transitions from creating to created when PR URL is detected', () => {
      // Set initial state to 'creating'
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })

      // Simulate what the hook does when a PR URL is found
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(prInfo?.state).toBe('creating')

      const text = 'I created a pull request: https://github.com/org/repo/pull/42'
      const match = text.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()

      if (match && prInfo && prInfo.state === 'creating') {
        const prNumber = parseInt(match[1], 10)
        useGitStore.getState().setPrState('wt-1', {
          ...prInfo,
          state: 'created',
          prNumber,
          prUrl: match[0]
        })
      }

      // Verify transition
      const updatedInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(updatedInfo?.state).toBe('created')
      expect(updatedInfo?.prNumber).toBe(42)
      expect(updatedInfo?.prUrl).toBe('https://github.com/org/repo/pull/42')
      // Original fields preserved
      expect(updatedInfo?.sessionId).toBe('session-1')
      expect(updatedInfo?.targetBranch).toBe('origin/main')
    })

    test('does not transition when state is not creating', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'created',
        prNumber: 10,
        prUrl: 'https://github.com/org/repo/pull/10'
      })

      const prInfo = useGitStore.getState().prInfo.get('wt-1')

      // Hook would check state before transitioning
      if (prInfo && prInfo.state === 'creating') {
        // This should NOT execute
        useGitStore.getState().setPrState('wt-1', {
          ...prInfo,
          state: 'created',
          prNumber: 99
        })
      }

      // State should be unchanged
      const info = useGitStore.getState().prInfo.get('wt-1')
      expect(info?.state).toBe('created')
      expect(info?.prNumber).toBe(10)
    })

    test('does not transition when state is none', () => {
      useGitStore.getState().setPrState('wt-1', { state: 'none' })

      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      if (prInfo && prInfo.state === 'creating') {
        useGitStore.getState().setPrState('wt-1', {
          ...prInfo,
          state: 'created',
          prNumber: 99
        })
      }

      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('none')
    })

    test('does not transition when state is merged', () => {
      useGitStore.getState().setPrState('wt-1', { state: 'merged', prNumber: 5 })

      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      if (prInfo && prInfo.state === 'creating') {
        useGitStore.getState().setPrState('wt-1', {
          ...prInfo,
          state: 'created',
          prNumber: 99
        })
      }

      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('merged')
    })

    test('does not transition when no PR URL found in text', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1'
      })

      const text = 'I am working on creating the pull request now...'
      const match = text.match(PR_URL_PATTERN)
      expect(match).toBeNull()

      // No transition should occur
      const info = useGitStore.getState().prInfo.get('wt-1')
      expect(info?.state).toBe('creating')
    })

    test('detects PR URL in tool output (gh pr create command)', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1'
      })

      // Simulate tool output from gh pr create
      const toolOutput =
        'Creating pull request for feature-branch into main\nhttps://github.com/org/repo/pull/55'
      const match = toolOutput.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()

      if (match) {
        const prInfo = useGitStore.getState().prInfo.get('wt-1')
        if (prInfo && prInfo.state === 'creating') {
          const prNumber = parseInt(match[1], 10)
          useGitStore.getState().setPrState('wt-1', {
            ...prInfo,
            state: 'created',
            prNumber,
            prUrl: match[0]
          })
        }
      }

      const info = useGitStore.getState().prInfo.get('wt-1')
      expect(info?.state).toBe('created')
      expect(info?.prNumber).toBe(55)
    })

    test('detects PR URL across accumulated text (simulating streaming deltas)', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1'
      })

      // Simulate incremental text accumulation as stream deltas arrive
      let accumulated = ''
      const deltas = [
        'I created the PR at ',
        'https://github.com/',
        'org/repo/pull/',
        '123',
        ' successfully!'
      ]

      let detected = false
      for (const delta of deltas) {
        accumulated += delta
        const match = accumulated.match(PR_URL_PATTERN)
        if (match && !detected) {
          detected = true
          const prInfo = useGitStore.getState().prInfo.get('wt-1')
          if (prInfo && prInfo.state === 'creating') {
            const prNumber = parseInt(match[1], 10)
            useGitStore.getState().setPrState('wt-1', {
              ...prInfo,
              state: 'created',
              prNumber,
              prUrl: match[0]
            })
          }
        }
      }

      expect(detected).toBe(true)
      const info = useGitStore.getState().prInfo.get('wt-1')
      expect(info?.state).toBe('created')
      expect(info?.prNumber).toBe(123)
      expect(info?.prUrl).toBe('https://github.com/org/repo/pull/123')
    })
  })
})
