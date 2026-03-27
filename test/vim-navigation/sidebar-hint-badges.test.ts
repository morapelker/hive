import { describe, it, expect } from 'vitest'
import {
  assignHints,
  buildNormalModeTargets,
  shouldShowHintBadge,
  type HintTarget
} from '@/lib/hint-utils'

describe('sidebar hint badges — normal mode', () => {
  describe('buildNormalModeTargets', () => {
    const projects = [
      { id: 'p1', name: 'Project One' },
      { id: 'p2', name: 'Project Two' },
      { id: 'p3', name: 'Project Three' }
    ]

    it('returns project targets for all projects', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)
      const projectTargets = targets.filter((t) => t.kind === 'project')

      expect(projectTargets).toHaveLength(3)
      expect(projectTargets.map((t) => t.projectId)).toEqual(['p1', 'p2', 'p3'])
    })

    it('includes worktree targets for ALL projects regardless of expanded state', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }, { id: 'w2', project_id: 'p1' }]],
        ['p2', [{ id: 'w3', project_id: 'p2' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)
      const worktreeTargets = targets.filter((t) => t.kind === 'worktree')

      // All worktrees included regardless of expanded state
      expect(worktreeTargets).toHaveLength(3)
      expect(worktreeTargets.map((t) => t.worktreeId)).toEqual(['w1', 'w2', 'w3'])
    })

    it('includes plus targets for every project', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)
      const plusTargets = targets.filter((t) => t.kind === 'plus')

      expect(plusTargets).toHaveLength(3)
      expect(plusTargets.map((t) => t.projectId)).toEqual(['p1', 'p2', 'p3'])
    })

    it('includes worktree targets even when no projects are expanded', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)

      expect(targets.filter((t) => t.kind === 'project')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'plus')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'worktree')).toHaveLength(1)
    })

    it('orders all projects first, then all worktrees (two-pass)', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]],
        ['p2', [{ id: 'w2', project_id: 'p2' }, { id: 'w3', project_id: 'p2' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)

      // Expected: all project+plus first, then all worktrees
      const labels = targets.map((t) => {
        if (t.kind === 'project') return `project:${t.projectId}`
        if (t.kind === 'plus') return `plus:${t.projectId}`
        return t.worktreeId
      })
      expect(labels).toEqual([
        'project:p1', 'plus:p1',
        'project:p2', 'plus:p2',
        'project:p3', 'plus:p3',
        'w1',
        'w2', 'w3'
      ])
    })

    it('produces stable hints regardless of expanded state', () => {
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]],
        ['p2', [{ id: 'w2', project_id: 'p2' }]]
      ])

      // Same result regardless — no expandedProjectIds parameter
      const targets1 = buildNormalModeTargets(projects, worktreesByProject)
      const targets2 = buildNormalModeTargets(projects, worktreesByProject)

      const { hintMap: hints1 } = assignHints(targets1, undefined, 'S')
      const { hintMap: hints2 } = assignHints(targets2, undefined, 'S')

      // Hint codes are identical
      expect([...hints1.entries()]).toEqual([...hints2.entries()])
    })

    it('handles empty projects list', () => {
      const targets = buildNormalModeTargets([], new Map())
      expect(targets).toHaveLength(0)
    })

    it('handles projects with no worktrees', () => {
      const worktreesByProject = new Map<string, Array<{ id: string; project_id: string }>>()

      const targets = buildNormalModeTargets(projects, worktreesByProject)

      expect(targets.filter((t) => t.kind === 'project')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'plus')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'worktree')).toHaveLength(0)
    })
  })

  describe('normal mode hints exclude S-prefix', () => {
    it('assignHints with excludeFirstChars "S" produces no S-prefixed codes', () => {
      const targets: HintTarget[] = [
        { kind: 'project', projectId: 'p1' },
        { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }
      ]
      const { hintMap } = assignHints(targets, undefined, 'S')

      for (const code of hintMap.values()) {
        expect(code[0]).not.toBe('S')
      }
    })

    it('normal mode targets assigned with S-exclusion still produce valid two-char codes', () => {
      const projects = [{ id: 'p1', name: 'P1' }]
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, worktreesByProject)
      const { hintMap } = assignHints(targets, undefined, 'S')

      expect(hintMap.size).toBe(3) // project + plus + worktree
      for (const code of hintMap.values()) {
        expect(code).toMatch(/^[A-RT-Z][a-z0-9]$/) // no S prefix
      }
    })
  })

  describe('shouldShowHintBadge', () => {
    it('returns true when inputFocused is true (filter mode)', () => {
      expect(shouldShowHintBadge('Aa', true, 'insert')).toBe(true)
    })

    it('returns true when vimMode is normal (vim mode)', () => {
      expect(shouldShowHintBadge('Aa', false, 'normal')).toBe(true)
    })

    it('returns false when no hint code', () => {
      expect(shouldShowHintBadge(undefined, true, 'normal')).toBe(false)
    })

    it('returns false when hint exists but neither inputFocused nor normal mode', () => {
      expect(shouldShowHintBadge('Aa', false, 'insert')).toBe(false)
    })

    it('returns true when both inputFocused and normal mode', () => {
      expect(shouldShowHintBadge('Aa', true, 'normal')).toBe(true)
    })

    it('returns false for empty string hint code', () => {
      expect(shouldShowHintBadge('', false, 'normal')).toBe(false)
    })
  })
})
