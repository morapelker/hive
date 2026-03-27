/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assignHints, assignSessionHints, dispatchHintAction, SECOND_CHARS } from '@/lib/hint-utils'

// Mock stores for dispatchHintAction tests
vi.mock('@/stores/useHintStore', () => {
  const store = {
    getState: vi.fn(() => ({
      hintTargetMap: new Map([
        ['w1', { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }]
      ])
    }))
  }
  return { useHintStore: store }
})

vi.mock('@/stores/useWorktreeStore', () => {
  const store = {
    getState: vi.fn(() => ({
      selectWorktree: vi.fn()
    }))
  }
  return { useWorktreeStore: store }
})

vi.mock('@/stores/useProjectStore', () => {
  const store = {
    getState: vi.fn(() => ({
      expandedProjectIds: new Set<string>(),
      selectProject: vi.fn(),
      toggleProjectExpanded: vi.fn()
    }))
  }
  return { useProjectStore: store }
})

describe('hint-utils extensions', () => {
  describe('assignHints with project kind', () => {
    it('generates key "project:p1" for kind:"project" targets', () => {
      const targets = [{ kind: 'project' as const, projectId: 'p1' }]
      const { hintMap } = assignHints(targets)
      expect(hintMap.has('project:p1')).toBe(true)
      expect(hintMap.get('project:p1')).toMatch(/^[A-Z][a-z0-9]$/)
    })

    it('with excludeFirstChars:"S" produces no S-prefixed codes', () => {
      // Create enough targets to span multiple first chars
      const targets = Array.from({ length: 70 }, (_, i) => ({
        kind: 'worktree' as const,
        worktreeId: `w${i}`,
        projectId: `p${i}`
      }))
      const { hintMap } = assignHints(targets, undefined, 'S')
      for (const code of hintMap.values()) {
        expect(code[0]).not.toBe('S')
      }
    })
  })

  describe('assignSessionHints', () => {
    it('returns empty maps for empty input', () => {
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints([])
      expect(sessionHintMap.size).toBe(0)
      expect(sessionHintTargetMap.size).toBe(0)
    })

    it('assigns S-prefixed codes for 3 sessions', () => {
      const { sessionHintMap } = assignSessionHints(['s1', 's2', 's3'])
      expect(sessionHintMap.get('s1')).toBe('Sa')
      expect(sessionHintMap.get('s2')).toBe('Sb')
      expect(sessionHintMap.get('s3')).toBe('Sc')
    })

    it('handles 34 sessions (full SECOND_CHARS capacity)', () => {
      const ids = Array.from({ length: 34 }, (_, i) => `s${i}`)
      const { sessionHintMap } = assignSessionHints(ids)
      expect(sessionHintMap.size).toBe(34)
      // Last one should be S + last SECOND_CHARS char
      expect(sessionHintMap.get('s33')).toBe('S' + SECOND_CHARS[33])
    })

    it('gracefully skips overflow beyond 34 sessions', () => {
      const ids = Array.from({ length: 40 }, (_, i) => `s${i}`)
      const { sessionHintMap } = assignSessionHints(ids)
      expect(sessionHintMap.size).toBe(34) // capped at SECOND_CHARS.length
    })
  })

  describe('dispatchHintAction', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('dispatches hive:hint-plus event for plus: keys', () => {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
      dispatchHintAction('plus:p1')
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'hive:hint-plus',
          detail: { projectId: 'p1' }
        })
      )
      dispatchSpy.mockRestore()
    })

    it('expands the project when dispatching plus: hint if collapsed', async () => {
      const { useProjectStore } = await import('@/stores/useProjectStore')
      const toggleFn = vi.fn()
      vi.mocked(useProjectStore.getState).mockReturnValue({
        expandedProjectIds: new Set<string>(),
        toggleProjectExpanded: toggleFn,
        selectProject: vi.fn()
      } as any)

      dispatchHintAction('plus:p1')
      expect(toggleFn).toHaveBeenCalledWith('p1')
    })

    it('does NOT toggle the project when dispatching plus: hint if already expanded', async () => {
      const { useProjectStore } = await import('@/stores/useProjectStore')
      const toggleFn = vi.fn()
      vi.mocked(useProjectStore.getState).mockReturnValue({
        expandedProjectIds: new Set(['p1']),
        toggleProjectExpanded: toggleFn,
        selectProject: vi.fn()
      } as any)

      dispatchHintAction('plus:p1')
      expect(toggleFn).not.toHaveBeenCalled()
    })

    it('calls toggleProjectExpanded for project: keys', async () => {
      const { useProjectStore } = await import('@/stores/useProjectStore')
      const toggleFn = vi.fn()
      vi.mocked(useProjectStore.getState).mockReturnValue({
        selectProject: vi.fn(),
        toggleProjectExpanded: toggleFn
      } as any)
      dispatchHintAction('project:p1')
      expect(toggleFn).toHaveBeenCalledWith('p1')
    })

    it('calls selectWorktree and selectProject for worktree keys', async () => {
      const { useHintStore } = await import('@/stores/useHintStore')
      const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
      const { useProjectStore } = await import('@/stores/useProjectStore')

      const selectWorktree = vi.fn()
      const selectProject = vi.fn()
      vi.mocked(useHintStore.getState).mockReturnValue({
        hintTargetMap: new Map([
          ['w1', { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }]
        ])
      } as any)
      vi.mocked(useWorktreeStore.getState).mockReturnValue({
        selectWorktree
      } as any)
      vi.mocked(useProjectStore.getState).mockReturnValue({
        expandedProjectIds: new Set<string>(),
        selectProject,
        toggleProjectExpanded: vi.fn()
      } as any)

      dispatchHintAction('w1')
      expect(selectWorktree).toHaveBeenCalledWith('w1')
      expect(selectProject).toHaveBeenCalledWith('p1')
    })

    it('auto-expands collapsed project when dispatching worktree hint', async () => {
      const { useHintStore } = await import('@/stores/useHintStore')
      const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
      const { useProjectStore } = await import('@/stores/useProjectStore')

      const toggleProjectExpanded = vi.fn()
      vi.mocked(useHintStore.getState).mockReturnValue({
        hintTargetMap: new Map([
          ['w1', { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }]
        ])
      } as any)
      vi.mocked(useWorktreeStore.getState).mockReturnValue({
        selectWorktree: vi.fn()
      } as any)
      vi.mocked(useProjectStore.getState).mockReturnValue({
        expandedProjectIds: new Set<string>(), // p1 is NOT expanded
        selectProject: vi.fn(),
        toggleProjectExpanded
      } as any)

      dispatchHintAction('w1')
      expect(toggleProjectExpanded).toHaveBeenCalledWith('p1')
    })

    it('does NOT toggle project when it is already expanded for worktree hint', async () => {
      const { useHintStore } = await import('@/stores/useHintStore')
      const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
      const { useProjectStore } = await import('@/stores/useProjectStore')

      const toggleProjectExpanded = vi.fn()
      vi.mocked(useHintStore.getState).mockReturnValue({
        hintTargetMap: new Map([
          ['w1', { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }]
        ])
      } as any)
      vi.mocked(useWorktreeStore.getState).mockReturnValue({
        selectWorktree: vi.fn()
      } as any)
      vi.mocked(useProjectStore.getState).mockReturnValue({
        expandedProjectIds: new Set(['p1']), // p1 IS expanded
        selectProject: vi.fn(),
        toggleProjectExpanded
      } as any)

      dispatchHintAction('w1')
      expect(toggleProjectExpanded).not.toHaveBeenCalled()
    })
  })
})
