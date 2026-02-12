import { describe, test, expect, beforeAll } from 'vitest'

/**
 * Session 7: Header Branding — Tests
 *
 * These tests verify:
 * 1. Logo image replaces the "Hive" text heading
 * 2. Project name displays when a project is selected
 * 3. Branch name displays in parentheses after the project name
 * 4. "Hive" fallback text when no project is selected
 * 5. Default worktree (no-worktree) hides branch name
 * 6. Logo asset exists
 */

describe('Session 7: Header Branding', () => {
  describe('Header.tsx source verification', () => {
    let source: string

    beforeAll(async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/layout/Header.tsx'),
        'utf-8'
      )
    })

    test('imports useProjectStore', () => {
      expect(source).toContain("import { useProjectStore } from '@/stores/useProjectStore'")
    })

    test('imports useWorktreeStore', () => {
      expect(source).toContain("import { useWorktreeStore } from '@/stores/useWorktreeStore'")
    })

    test('imports hiveLogo from assets', () => {
      expect(source).toContain("import hiveLogo from '@/assets/icon.png'")
    })

    test('renders logo image with correct attributes', () => {
      expect(source).toContain('src={hiveLogo}')
      expect(source).toContain('alt="Hive"')
      expect(source).toContain('draggable={false}')
      expect(source).toContain('rounded')
    })

    test('shows project name when project selected', () => {
      expect(source).toContain('selectedProject.name')
    })

    test('shows branch name in parentheses with primary color', () => {
      expect(source).toContain('selectedWorktree?.branch_name')
      expect(source).toMatch(/\(\s*\{selectedWorktree\.branch_name\}\s*\)/)
      expect(source).toContain('text-primary')
    })

    test('shows "Hive" fallback when no project selected', () => {
      // There should be a fallback that renders "Hive" text
      const fallbackMatch = source.match(/:\s*\(\s*<span[^>]*>Hive<\/span>/)
      expect(fallbackMatch).not.toBeNull()
    })

    test('does not show branch for default worktree (no-worktree)', () => {
      expect(source).toContain("'(no-worktree)'")
    })

    test('no longer has h1 Hive heading', () => {
      expect(source).not.toContain('<h1')
    })

    test('uses truncate class for long project/branch names', () => {
      expect(source).toContain('truncate')
    })

    test('uses min-w-0 for flex truncation', () => {
      expect(source).toContain('min-w-0')
    })

    test('uses shrink-0 on logo to prevent shrinking', () => {
      expect(source).toContain('shrink-0')
    })

    test('uses selectedProjectId from useProjectStore', () => {
      expect(source).toContain('selectedProjectId')
      expect(source).toContain('useProjectStore')
    })

    test('looks up selectedWorktree from worktreesByProject', () => {
      expect(source).toContain('worktreesByProject')
      expect(source).toContain('selectedWorktreeId')
    })

    test('has data-testid for header project info', () => {
      expect(source).toContain('data-testid="header-project-info"')
    })
  })

  describe('Logo asset exists', () => {
    test('icon.png exists in assets directory', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const assetPath = path.resolve(__dirname, '../../../src/renderer/src/assets/icon.png')
      expect(fs.existsSync(assetPath)).toBe(true)
    })
  })

  describe('Type declaration for PNG imports exists', () => {
    test('assets.d.ts declares *.png module', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const dtsPath = path.resolve(__dirname, '../../../src/renderer/src/assets.d.ts')
      expect(fs.existsSync(dtsPath)).toBe(true)
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain("declare module '*.png'")
    })
  })
})
