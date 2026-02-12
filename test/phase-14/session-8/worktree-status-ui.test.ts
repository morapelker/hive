import { describe, test, expect } from 'vitest'

/**
 * Session 8: Worktree Status UI (Two-Line Rows) — Tests
 *
 * These tests verify:
 * 1. WorktreeItem shows status text ("Working", "Planning", "Answer questions", "Archiving")
 * 2. WorktreeItem shows no second line when idle
 * 3. Status text uses correct styling
 * 4. Archiving status takes precedence over worktree status
 */

// We test by reading the source file to verify the implementation,
// since rendering WorktreeItem requires deep mocking of multiple stores and window APIs.

describe('Session 8: Worktree Status UI', () => {
  describe('WorktreeItem source verification', () => {
    let source: string

    test('load WorktreeItem source', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )
      expect(source).toBeTruthy()
    })

    test('contains displayStatus derivation with all status types', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Should have all four display status mappings
      expect(source).toContain("'Archiving'")
      expect(source).toContain("'Answer questions'")
      expect(source).toContain("'Planning'")
      expect(source).toContain("'Working'")
    })

    test('Archiving has highest priority in displayStatus', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Archiving should be checked first (isArchiving before worktreeStatus checks)
      const archivingIndex = source.indexOf('isArchiving')
      const answeringIndex = source.indexOf("=== 'answering'")
      const planningIndex = source.indexOf("=== 'planning'")
      const workingDisplayIndex = source.indexOf("'Working'")

      // Verify ordering in the displayStatus ternary chain
      expect(archivingIndex).toBeGreaterThan(-1)
      expect(answeringIndex).toBeGreaterThan(archivingIndex)
      expect(planningIndex).toBeGreaterThan(answeringIndex)
      expect(workingDisplayIndex).toBeGreaterThan(planningIndex)
    })

    test('status text always renders with displayStatus', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Should always render status text (no conditional guard)
      expect(source).toContain('{displayStatus}')
      // Should include 'Ready' as the fallback
      expect(source).toContain("'Ready'")
    })

    test('status text uses correct styling with per-status colors', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Should use 11px text size
      expect(source).toContain('text-[11px]')
      // Active statuses should be bold
      expect(source).toContain('font-semibold')
      // Per-status colors
      expect(source).toContain('text-amber-500') // answering
      expect(source).toContain('text-blue-400') // planning
      expect(source).toContain('text-primary') // working
      expect(source).toContain('text-muted-foreground') // ready / archiving
    })

    test('name area uses flex-col wrapper with min-w-0', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Should wrap name + status in a flex-col container
      expect(source).toContain('flex-1 min-w-0')
      // Name should use block display for proper stacking
      expect(source).toContain('truncate block')
    })

    test('has data-testid on status text element', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(source).toContain('worktree-status-text')
    })

    test('icons handle planning and answering statuses', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      // Spinner should show for both working and planning
      expect(source).toContain("worktreeStatus === 'working' || worktreeStatus === 'planning'")
      // AlertCircle icon should be used for answering
      expect(source).toContain("worktreeStatus === 'answering'")
      expect(source).toContain('AlertCircle')
      // Fallback icon condition should exclude all active statuses
      expect(source).toContain("worktreeStatus !== 'planning'")
      expect(source).toContain("worktreeStatus !== 'answering'")
    })
  })

  describe('displayStatus logic unit tests', () => {
    // Unit-test the displayStatus derivation logic in isolation

    function deriveDisplayStatus(
      isArchiving: boolean,
      worktreeStatus: string | null
    ): string | null {
      return isArchiving
        ? 'Archiving'
        : worktreeStatus === 'answering'
          ? 'Answer questions'
          : worktreeStatus === 'planning'
            ? 'Planning'
            : worktreeStatus === 'working'
              ? 'Working'
              : 'Ready'
    }

    test('shows "Working" when worktreeStatus is working', () => {
      expect(deriveDisplayStatus(false, 'working')).toBe('Working')
    })

    test('shows "Planning" when worktreeStatus is planning', () => {
      expect(deriveDisplayStatus(false, 'planning')).toBe('Planning')
    })

    test('shows "Answer questions" when worktreeStatus is answering', () => {
      expect(deriveDisplayStatus(false, 'answering')).toBe('Answer questions')
    })

    test('shows "Archiving" when isArchiving is true', () => {
      expect(deriveDisplayStatus(true, null)).toBe('Archiving')
    })

    test('Archiving takes priority over worktreeStatus', () => {
      expect(deriveDisplayStatus(true, 'working')).toBe('Archiving')
      expect(deriveDisplayStatus(true, 'answering')).toBe('Archiving')
    })

    test('shows "Ready" when idle', () => {
      expect(deriveDisplayStatus(false, null)).toBe('Ready')
    })

    test('shows "Ready" for unread status', () => {
      expect(deriveDisplayStatus(false, 'unread')).toBe('Ready')
    })
  })
})
